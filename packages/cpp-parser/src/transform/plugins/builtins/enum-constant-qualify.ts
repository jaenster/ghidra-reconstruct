/**
 * Enum-Constant-Qualify Plugin
 *
 * Two enums can declare the same constant name with different numbers.
 * `eD2PlayerAnimMode` and `eD2MonsterAnimMode` share fourteen names and agree on
 * none of them past `Walk`: `Run` is 3 for a player and 15 for a monster,
 * `Dead` is 17 and 12, `Attack1` is 7 and 4.
 *
 * `d2_enums.h` therefore refuses to export such a name at global scope - no
 * single global spelling of `Run` can be right for both switches. Only the
 * qualified form means anything:
 *
 *     switch (pUnit->eAnimMode.ePlayerMode) {
 *       case eD2PlayerAnimMode_ns::Run:      // 3, what Ghidra said
 *
 * This pass writes that qualifier, and it takes it from the CONTROLLING TYPE,
 * never from the label. The switch's condition, the other side of an equality
 * test, the assigned-to lvalue - each says which enum is meant, and the name is
 * qualified to that enum only when that enum really declares it. Where the type
 * is unknown, or the enum does not declare the name, the reference is left
 * exactly as Ghidra wrote it, and the missing global export turns it into a
 * compile error. A name borrowed from a different enum would compile and branch
 * on the wrong mode, which is the failure this exists to prevent.
 *
 * Only ambiguous names are touched. The ~8.6k constants that mean one number
 * everywhere keep their unqualified spelling and their global export.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CaseStmt, CompoundStmt, DefaultStmt, Expression, FunctionDecl,
  Identifier, IfStmt, LabelStmt, ParameterDecl, SwitchStmt, TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens } from './call-arg-cast.js';

export interface EnumConstantQualifyOptions extends PluginOptions {
  /** Names declared by more than one enum with different values. */
  ambiguousConstants?: string[];
  /** Enum name → the member names it declares. */
  enumMembers?: Record<string, readonly string[]>;
  /** Aggregate name → member name → member spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, where the name is unambiguous tree-wide. */
  fieldTypes?: Record<string, string>;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
  /** Function name → return spelling. */
  returnTypes?: Record<string, string>;
}

interface Model {
  ambiguous: ReadonlySet<string>;
  members: ReadonlyMap<string, ReadonlySet<string>>;
}

const modelCache = new WeakMap<object, Model | null>();

function buildModel(options: EnumConstantQualifyOptions): Model | null {
  const cached = modelCache.get(options);
  if (cached !== undefined) return cached;
  const ambiguous = new Set(options.ambiguousConstants ?? []);
  const members = new Map<string, ReadonlySet<string>>();
  for (const [enumName, names] of Object.entries(options.enumMembers ?? {})) {
    members.set(enumName, new Set(names));
  }
  const model = ambiguous.size > 0 && members.size > 0 ? { ambiguous, members } : null;
  modelCache.set(options, model);
  return model;
}

/**
 * Note: no typedef resolver is passed to `createExprShape`. `d2_enums.h` spells
 * every enum `typedef int <Enum>;`, and resolving that would collapse the very
 * identity this pass is deciding on down to `int`.
 */
function createEnumConstantQualifyTransformer(
  options: EnumConstantQualifyOptions = {},
): Transformer {
  const model = buildModel(options);
  if (!model) return createTransformer({});

  const tables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields: options.structFields,
    fieldTypes: options.fieldTypes,
    returnTypes: options.returnTypes,
  };

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }

      const shape = createExprShape(localTypes, tables);

      /** The enum an expression has, or undefined when it is not one. */
      const enumOf = (expr: Expression | undefined): string | undefined => {
        if (!expr) return undefined;
        const s = shape(expr);
        if (!s || s.stars !== 0) return undefined;
        return model.members.has(s.base) ? s.base : undefined;
      };

      /** `Name` → `<Enum>_ns::Name`, only when that enum declares it. */
      const qualify = (expr: Expression, enumName: string): Expression | undefined => {
        const e = unwrapParens(expr);
        if (e.kind !== NodeKind.Identifier) return undefined;
        const name = (e as Identifier).name;
        if (!model.ambiguous.has(name)) return undefined;
        if (!model.members.get(enumName)?.has(name)) return undefined;
        return {
          ...Expr.qualifiedId([`${enumName}_ns`, name]),
          leadingTrivia: expr.leadingTrivia,
          trailingTrivia: expr.trailingTrivia,
        } as Expression;
      };

      /**
       * Qualify the labels of ONE switch, and only its own: the recursion stops
       * at a nested `switch`, whose labels answer to its condition, not this
       * one's. The pipeline transforms children before their parent, so a nested
       * switch has already been through this by the time the outer one is
       * reached.
       */
      const qualifyLabels = (stmt: ASTNode, enumName: string): ASTNode => {
        if (stmt.kind === NodeKind.SwitchStmt) return stmt;
        const recur = <T extends ASTNode>(child: T): T => qualifyLabels(child, enumName) as T;
        switch (stmt.kind) {
          case NodeKind.CaseStmt: {
            const c = stmt as CaseStmt;
            const value = qualify(c.value, enumName);
            const statement = recur(c.statement);
            if (!value && statement === c.statement) return c;
            return updateNode(c, { ...(value ? { value } : {}), statement } as Partial<CaseStmt>);
          }
          case NodeKind.DefaultStmt: {
            const d = stmt as DefaultStmt;
            const statement = recur(d.statement);
            return statement === d.statement ? d : updateNode(d, { statement } as Partial<DefaultStmt>);
          }
          case NodeKind.LabelStmt: {
            const l = stmt as LabelStmt;
            const statement = recur(l.statement);
            return statement === l.statement ? l : updateNode(l, { statement } as Partial<LabelStmt>);
          }
          case NodeKind.CompoundStmt: {
            const b = stmt as CompoundStmt;
            const statements = b.statements.map(recur);
            return statements.some((s, i) => s !== b.statements[i])
              ? updateNode(b, { statements } as Partial<CompoundStmt>)
              : b;
          }
          // Ghidra sometimes emits a label inside a conditional arm of the
          // switch body rather than at its top level.
          case NodeKind.IfStmt: {
            const f = stmt as IfStmt;
            const thenBranch = recur(f.thenBranch);
            const elseBranch = f.elseBranch ? recur(f.elseBranch) : f.elseBranch;
            return thenBranch === f.thenBranch && elseBranch === f.elseBranch
              ? f
              : updateNode(f, { thenBranch, elseBranch } as Partial<IfStmt>);
          }
          default:
            return stmt;
        }
      };

      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.SwitchStmt) {
            const s = n as SwitchStmt;
            const enumName = enumOf(s.condition);
            if (!enumName) return undefined;
            const body = qualifyLabels(s.body, enumName) as SwitchStmt['body'];
            return body === s.body ? undefined : updateNode(s, { body } as Partial<SwitchStmt>);
          }
          if (n.kind === NodeKind.BinaryExpr) {
            const b = n as BinaryExpr;
            if (b.operator !== '==' && b.operator !== '!=') return undefined;
            const fromLeft = enumOf(b.left);
            if (fromLeft) {
              const right = qualify(b.right, fromLeft);
              if (right) return updateNode(b, { right } as Partial<BinaryExpr>);
            }
            const fromRight = enumOf(b.right);
            if (fromRight) {
              const left = qualify(b.left, fromRight);
              if (left) return updateNode(b, { left } as Partial<BinaryExpr>);
            }
            return undefined;
          }
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=') return undefined;
            const enumName = enumOf(a.left);
            if (!enumName) return undefined;
            const right = qualify(a.right, enumName);
            return right && updateNode(a, { right } as Partial<AssignExpr>);
          }
          return undefined;
        },
      });

      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const enumConstantQualifyPlugin: TransformPlugin = {
  id: 'enum-constant-qualify',
  name: 'Enum Constant Qualification',
  description:
    'Qualify an enum constant whose name several enums declare with different values to the enum '
    + "the switch condition, comparison or assignment target says is meant",
  version: '1.0.0',
  defaultEnabled: true,
  // After switch-reconstruct (which recognises a case label by its BARE name,
  // so the qualifier must not exist yet) and after struct-field, which is what
  // turns an offset deref into the member read the controlling type is read off.
  priority: 60,
  tags: ['type', 'enums', 'correctness'],
  createTransformer: createEnumConstantQualifyTransformer,
};

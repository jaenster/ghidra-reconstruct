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
 * never from the label. Six places state that type - the switch's condition, the
 * other side of a comparison or a bitwise operator, the assignment target, the
 * declared type of an initialised variable, the callee's declared parameter,
 * and (for a local Ghidra typed as a plain integer) whatever enum-typed value is
 * assigned to it. The name is qualified to that enum only when that enum really
 * declares it. Where the type is unknown, or the enum does not declare the name,
 * the reference is left exactly as Ghidra wrote it, and the missing global
 * export turns it into a compile error. A name borrowed from a different enum
 * would compile and branch on the wrong mode, which is the failure this exists
 * to prevent.
 *
 * Only ambiguous names are touched. The ~8.6k constants that mean one number
 * everywhere keep their unqualified spelling and their global export.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CaseStmt, CompoundStmt, DefaultStmt, Expression,
  FunctionDecl, Identifier, IfStmt, LabelStmt, ParameterDecl, ParenExpr, QualifiedId, SwitchStmt,
  TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { calleeName, scopedLookup, shapeOfNode, unwrapParens } from './call-arg-cast.js';

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
  /** Function name → the spelling of each declared parameter. */
  functionParamTypes?: Record<string, string[]>;
  /** The namespace path the body is emitted inside, for unqualified callee lookup. */
  enclosingSegments?: string[];
}

/**
 * Operators whose two operands are values of the same type, so one side's enum
 * names the other's - `+`/`-` included, because a decompiled `mode + Neutral` is
 * Ghidra spelling that enum's 1, not an untyped offset. `&&`/`||` are excluded:
 * their operands are booleans, and a name there means nothing about an enum.
 */
const TYPED_BINARY_OPS: ReadonlySet<string> = new Set([
  '==', '!=', '<', '>', '<=', '>=', '&', '|', '^', '+', '-',
]);

/**
 * Operators that combine members of ONE enum into another value of it, so a
 * qualifier pushed into the expression reaches every name inside it -
 * `mode & (Skill4 | Skill3)` names both from the enum `mode` has.
 */
const MEMBER_COMBINING_OPS: ReadonlySet<string> = new Set(['&', '|', '^', '+', '-']);
/**
 * The compound assignments whose right operand is a value of the LEFT's type.
 * The same set as `TYPED_BINARY_OPS` restricted to what can be compounded, and
 * for the same reason: `mode -= Neutral` is Ghidra spelling that enum's 1, not
 * an untyped offset, exactly as `mode - Neutral` is.
 */
const TYPED_ASSIGN_OPS: ReadonlySet<string> = new Set(['&=', '|=', '^=', '+=', '-=']);

/** The undecorated name of a declared type - null for anything with a `*`. */
function typeBaseName(type: TypeNode | undefined): string | undefined {
  if (!type) return undefined;
  const shape = shapeOfNode(type, 0);
  return shape && shape.stars === 0 ? shape.base : undefined;
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

  const paramTypes = options.functionParamTypes ?? {};
  const enclosingSegments = options.enclosingSegments ?? [];

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

      /**
       * A local Ghidra declared as a plain integer but only ever assigns an
       * enum-typed value to. `bool _bNeedsGfxReload` is assigned
       * `pItem->eAnimMode.ePlayerMode` and then compared against `Neutral`: the
       * declared type is a lie the decompiler tells about a one-byte slot, and
       * the assignment is what says which enum the comparison is over. Recorded
       * only where every enum-typed assignment to the name agrees.
       */
      const assignedEnums = new Map<string, string | null>();
      const noteAssignment = (name: string, base: string | undefined): void => {
        if (!base || !model.members.has(base)) return;
        const seen = assignedEnums.get(name);
        if (seen === undefined) assignedEnums.set(name, base);
        else if (seen !== base) assignedEnums.set(name, null);
      };
      for (const a of findNodesByKind(node.body, NodeKind.AssignExpr)) {
        const asg = a as AssignExpr;
        if (asg.operator !== '=') continue;
        const target = unwrapParens(asg.left);
        if (target.kind !== NodeKind.Identifier) continue;
        const s = shape(asg.right);
        noteAssignment((target as Identifier).name, s && s.stars === 0 ? s.base : undefined);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!v.initializer) continue;
        const s = shape(v.initializer as Expression);
        noteAssignment(v.name.name, s && s.stars === 0 ? s.base : undefined);
      }

      /** The enum an expression has, or undefined when it is not one. */
      const enumOf = (expr: Expression | undefined): string | undefined => {
        if (!expr) return undefined;
        const e = unwrapParens(expr);
        const s = shape(e);
        if (s && s.stars === 0 && model.members.has(s.base)) return s.base;
        if (e.kind !== NodeKind.Identifier) return undefined;
        return assignedEnums.get((e as Identifier).name) ?? undefined;
      };

      /**
       * `Name` → `<Enum>_ns::Name`, only when that enum declares it. A
       * parenthesised combination of members - `(Skill4 | Skill3)` - is
       * qualified through, each leaf on its own; anything else is left alone.
       */
      const qualify = (expr: Expression, enumName: string): Expression | undefined => {
        if (expr.kind === NodeKind.ParenExpr) {
          const inner = qualify((expr as ParenExpr).expression, enumName);
          return inner && updateNode(expr, { expression: inner } as Partial<ParenExpr>);
        }
        if (expr.kind === NodeKind.BinaryExpr) {
          const b = expr as BinaryExpr;
          if (!MEMBER_COMBINING_OPS.has(b.operator)) return undefined;
          const left = qualify(b.left, enumName);
          const right = qualify(b.right, enumName);
          if (!left && !right) return undefined;
          return updateNode(b, {
            left: left ?? b.left,
            right: right ?? b.right,
          } as Partial<BinaryExpr>);
        }
        if (expr.kind !== NodeKind.Identifier) return undefined;
        const name = (expr as Identifier).name;
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
            if (!TYPED_BINARY_OPS.has(b.operator)) return undefined;
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
          if (n.kind === NodeKind.CallExpr) {
            // A parameter declared with an enum type says which enum the
            // argument means. This is where the MonStats bit-offset flags live:
            // `TXT_MonStats_MonStats2_GetFlagsByBitOffset(nClassId, revive)`
            // reads `revive` from an index enum, never from the bitfield enum
            // that numbers it 0 instead of 8.
            const call = n as CallExpr;
            const name = calleeName(call.callee);
            if (!name) return undefined;
            const params = scopedLookup(paramTypes, name, enclosingSegments);
            if (!params) return undefined;
            let touched = false;
            const args = call.arguments.map((a, i) => {
              const declared = params[i]?.trim();
              if (!declared || !model.members.has(declared)) return a;
              const next = qualify(a, declared);
              if (!next) return a;
              touched = true;
              return next;
            });
            return touched ? updateNode(call, { arguments: args } as Partial<CallExpr>) : undefined;
          }
          if (n.kind === NodeKind.VariableDecl) {
            // `eD2PlayerAnimMode eAnimMode = Attack1;` — the declaration says
            // the enum outright.
            const v = n as VariableDecl;
            if (!v.initializer) return undefined;
            const declared = typeBaseName(v.type);
            if (!declared || !model.members.has(declared)) return undefined;
            const initializer = qualify(v.initializer as Expression, declared);
            return initializer && updateNode(v, { initializer } as Partial<VariableDecl>);
          }
          if (n.kind === NodeKind.AssignExpr) {
            const a = n as AssignExpr;
            if (a.operator !== '=' && !TYPED_ASSIGN_OPS.has(a.operator)) return undefined;
            const enumName = enumOf(a.left);
            if (!enumName) return undefined;
            const right = qualify(a.right, enumName);
            return right && updateNode(a, { right } as Partial<AssignExpr>);
          }
          return undefined;
        },
      });

      const body = sub(node.body);

      /**
       * The seventh source, and still a CONTROLLING TYPE rather than a label:
       * one that six lines away in the same body already settled.
       *
       *     if (eAnimMode == eD2PlayerAnimMode_ns::Neutral) ...   // settled
       *     D2Common::Units::SetupUpdateFlag(pUnit, Neutral);     // int32_t param
       *
       * `SetupUpdateFlag` takes `int32_t` - sixty callers push item, object,
       * missile and player modes through it - so no parameter type names the
       * enum, and `Neutral` is one of the names `d2_enums.h` refuses to export
       * (Monster 1, Object 0, Player 1). The other site in the body carries the
       * answer, and it got it from a declared type.
       *
       * Applied only where the body resolved the name to exactly ONE enum, and
       * only to a bare identifier that is not a declared name here. Where two
       * enums appear for one name, nothing is written and the error stays.
       */
      const settled = new Map<string, string | null>();
      for (const q of findNodesByKind(body, NodeKind.QualifiedId)) {
        const qi = q as QualifiedId;
        if (qi.qualifier.length !== 1 || qi.name.kind !== NodeKind.Identifier) continue;
        const scope = qi.qualifier[0];
        if (scope.kind !== NodeKind.Identifier) continue;
        const enumName = (scope as Identifier).name.replace(/_ns$/, '');
        if (enumName === (scope as Identifier).name) continue;
        const member = (qi.name as Identifier).name;
        if (!model.ambiguous.has(member)) continue;
        if (!model.members.get(enumName)?.has(member)) continue;
        const seen = settled.get(member);
        if (seen === undefined) settled.set(member, enumName);
        else if (seen !== enumName) settled.set(member, null);
      }
      if (settled.size === 0) return updateNode(node, { body } as Partial<FunctionDecl>);

      const fromBody = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind !== NodeKind.Identifier) return undefined;
          const name = (n as Identifier).name;
          if (localTypes.has(name)) return undefined;
          const enumName = settled.get(name);
          if (!enumName) return undefined;
          return qualify(n as Expression, enumName);
        },
      });

      return updateNode(node, { body: fromBody(body) } as Partial<FunctionDecl>);
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

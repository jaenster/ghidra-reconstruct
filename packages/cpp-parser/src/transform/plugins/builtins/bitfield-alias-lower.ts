/**
 * Bitfield-Alias Lowering Plugin
 *
 * Ghidra's decompiler reads a storage unit that holds bitfields by a whole-unit
 * ALIAS name it makes up on the spot:
 *
 *   (byte)pPetType->field_0x4 & 0x20
 *   uint8_t *puVar1 = &pSkillsTxt->field_0x4;
 *   *(uint *)&pMissilesTxt->field_0x4
 *
 * There is no such member. `D2SkillsTxt` offset 4 is eight `int:1` bitfields
 * (`decquant`, `lob`, `progressive`, …) and `D2PetTypeTxt` offset 4 is six -
 * Ghidra's struct is RICHER than the alias, not poorer. The decompiler falls
 * back to the alias whenever the code touches the whole byte or dword instead of
 * one bit, and the emitted header, which declares the bitfields Ghidra actually
 * models, then has nothing named `field_0x4` on it.
 *
 * Most `field_0xN` reads in the tree are NOT this: they name genuine unnamed
 * filler the header does declare, at the offset the decompiler spells. Telling
 * the two apart takes two things and nothing less:
 *
 *   - the member set the header emitter really wrote for that aggregate
 *     (`emittedMemberNames`, taken from the emitter itself so the two cannot
 *     drift), and
 *   - the object's type, so the question is asked of the right aggregate.
 *
 * When the object's type is unknown, or the aggregate is not in the model, or
 * the aggregate does declare the name, nothing happens. Only a read the model
 * positively knows is an alias is lowered, to the byte-offset deref the
 * decompiler meant:
 *
 *   obj->field_0xN   →   *((uint8_t *)obj + N)
 *   obj.field_0xN    →   *((uint8_t *)&obj + N)
 *
 * which is an lvalue of the same byte, so a read, an assignment and an `&`
 * around it all keep working - `*(uint32_t *)&pX->field_0x4` becomes
 * `*(uint32_t *)&*((uint8_t *)pX + 4)`, the same four bytes at the same address.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, Expression, FunctionDecl, MemberExpr, ParameterDecl, UnaryExpr, VariableDecl, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Expr, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { unwrapParens } from './call-arg-cast.js';
import type { TypedefResolver } from './call-arg-cast.js';

export interface BitfieldAliasLowerOptions extends PluginOptions {
  /** Aggregate name → every member name its emitted declaration carries. */
  aggregateMembers?: Record<string, readonly string[]>;
  /** Aggregate name → member name → member spelling (object-type inference). */
  structFields?: Record<string, Record<string, string>>;
  /** Member name → spelling, where the name is unambiguous tree-wide. */
  fieldTypes?: Record<string, string>;
  /** Global name → declared spelling. */
  globalTypes?: Record<string, string>;
  /** A name declared by the enclosing class/namespace body. */
  enclosingVarTypes?: Record<string, string>;
  /** Function name → return spelling. */
  returnTypes?: Record<string, string>;
  /** Typedef name → what it stands for. */
  typedefTargets?: Record<string, string>;
}

/** Ghidra's alias spelling: `field_0x` then unpadded lowercase hex. */
const ALIAS_RE = /^field_0x([0-9a-fA-F]+)$/;

const memberSetCache = new WeakMap<object, Map<string, ReadonlySet<string>>>();

function memberSets(
  aggregateMembers: Record<string, readonly string[]>,
): Map<string, ReadonlySet<string>> {
  let cached = memberSetCache.get(aggregateMembers);
  if (!cached) {
    cached = new Map();
    for (const [name, members] of Object.entries(aggregateMembers)) {
      cached.set(name, new Set(members));
    }
    memberSetCache.set(aggregateMembers, cached);
  }
  return cached;
}

function createBitfieldAliasLowerTransformer(options: BitfieldAliasLowerOptions = {}): Transformer {
  const aggregateMembers = options.aggregateMembers;
  if (!aggregateMembers || Object.keys(aggregateMembers).length === 0) {
    return createTransformer({});
  }
  const members = memberSets(aggregateMembers);
  const typedefTargets = options.typedefTargets;
  const resolve: TypedefResolver | undefined = typedefTargets
    ? (name: string) => typedefTargets[name]
    : undefined;
  const tables = {
    globalTypes: options.globalTypes,
    enclosingVarTypes: options.enclosingVarTypes,
    structFields: options.structFields,
    fieldTypes: options.fieldTypes,
    returnTypes: options.returnTypes,
    resolve,
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

      /** The ADDRESS an alias read stands for, or undefined when it is a real member. */
      const aliasAddress = (m: MemberExpr): Expression | undefined => {
        const memberName = (m.member as { name?: string })?.name;
        if (typeof memberName !== 'string') return undefined;
        const match = ALIAS_RE.exec(memberName);
        if (!match) return undefined;

        // Which aggregate is being read? Without an answer there is no
        // question to ask, and a guess would rewrite a member that exists.
        const obj = shape(m.object);
        if (!obj) return undefined;
        if (obj.stars !== (m.isArrow ? 1 : 0)) return undefined;
        const declared = members.get(obj.base);
        if (!declared) return undefined;
        if (declared.has(memberName)) return undefined;

        const offset = Number.parseInt(match[1], 16);
        if (!Number.isFinite(offset)) return undefined;

        const base: Expression = m.isArrow ? m.object : Expr.addressOf(m.object);
        const bytePtr = Expr.cast(Type.pointer(Type.builtin('uint8_t')), base);
        return offset === 0
          ? bytePtr
          : Expr.paren(Expr.add(bytePtr, Expr.intLiteral(offset, 16)));
      };

      // Children are rewritten before their parent is visited, so the `&` case
      // sees a deref this pass just made rather than the member read. Remember
      // which derefs those are and cancel the pair, so `&pX->field_0x4` comes
      // out as the address it always was instead of `&*(…)`.
      const lowered = new WeakMap<object, Expression>();

      const sub = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          if (n.kind === NodeKind.UnaryExpr) {
            const u = n as UnaryExpr;
            if (u.operator !== '&') return undefined;
            const at = lowered.get(unwrapParens(u.operand));
            return at && { ...at, leadingTrivia: u.leadingTrivia, trailingTrivia: u.trailingTrivia };
          }
          if (n.kind !== NodeKind.MemberExpr) return undefined;
          const at = aliasAddress(n as MemberExpr);
          if (!at) return undefined;
          const deref: ASTNode = {
            ...Expr.deref(at),
            leadingTrivia: n.leadingTrivia,
            trailingTrivia: n.trailingTrivia,
          };
          lowered.set(deref, at);
          return deref;
        },
      });

      return updateNode(node, { body: sub(node.body) } as Partial<FunctionDecl>);
    },
  });
}

export const bitfieldAliasLowerPlugin: TransformPlugin = {
  id: 'bitfield-alias-lower',
  name: 'Bitfield-Alias Lowering',
  description:
    "Lower a Ghidra whole-unit alias read (`p->field_0xN`) that the aggregate does not declare "
    + 'to the byte-offset deref it stands for',
  version: '1.0.0',
  defaultEnabled: true,
  // After struct-field (50), which is what turns raw offset derefs INTO member
  // reads; this pass only ever undoes a member read the model rejects.
  priority: 55,
  tags: ['cleanup', 'structs', 'type'],
  createTransformer: createBitfieldAliasLowerTransformer,
};

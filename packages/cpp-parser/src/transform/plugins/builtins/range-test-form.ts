/**
 * Range Test Form Plugin
 *
 * VC8 folds a two-sided range test on a variable, `lo <= x && x <= hi`, into one unsigned
 * compare: `ADD x, -lo; CMP x, hi - lo; JA`. Ghidra prints that as the difference
 * (`nConnectResult - 1 < 2`), and the tree compiles the difference as written, which VC8
 * emits as `SUB x, lo` - one opcode away from the original. MAINMENU_DeleteCharacterOnRealm
 * @00434960:
 *
 *   original              tree before                     tree after
 *   ADD EAX,-1            if (nConnectResult - 1 <= 1)    if (nConnectResult >= 1 && nConnectResult <= 2)
 *   CMP EAX,1
 *   JA  ...
 *
 * VC8 folds only some spellings, so the rewrite is limited to the one measured to fold: the
 * `&&` form that guards the branch it is the condition of (an `if` condition or one conjunct
 * of its top-level `&&` chain), on a parameter or local, read as an integer of at most 32
 * bits. A field (`p->n`), a masked value, or the inverted form (`x < lo || x > hi`) compile
 * as two compares, and an 8-bit difference (`(uint8_t)(c - 0x20) <= 0x5f`) is a SUB in the
 * original as well, so those stay.
 *
 * The rewrite keeps the value. The difference must already be unsigned 32-bit arithmetic (a
 * cast to a 32-bit unsigned type, a `U` constant, or an operand declared unsigned 32-bit),
 * so the test is `x - lo` in [0, k] modulo 2^32, i.e. x is one of lo..lo+k modulo 2^32. With
 * 0 < lo and lo + k < 2^31 that set is the same contiguous interval whether x is read signed
 * or unsigned, so `x >= lo && x <= lo + k` - in whichever signedness x's type gives the
 * compares - holds for exactly the same x. The variable is read twice; a local or parameter
 * read has no side effect.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, BinaryExpr, CStyleCastExpr, Expression, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr,
  ParameterDecl, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { createExprShape } from './expr-shape.js';
import { shapeOfNode, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { Expr } from '../../../ast/factory.js';

export interface RangeTestFormOptions extends PluginOptions {
  enumTypes?: string[];
  /** Enum constant name -> value. */
  enumValues?: Record<string, number>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
}

const UNSIGNED32 = new Set(['uint32_t', 'uint', 'unsigned int', 'unsigned', 'DWORD', 'UINT', 'ULONG', 'unsigned long', 'u32', 'size_t', 'uintptr_t']);
const NARROW = new Set([
  'int', 'int32_t', 'long', 'INT', 'LONG', 'BOOL', 'bool', 'short', 'int16_t', 'char', 'signed char', 'int8_t',
  'uint8_t', 'uint16_t', 'unsigned char', 'unsigned short', 'byte', 'ushort', 'uchar', 'BYTE', 'WORD', 'UCHAR', 'USHORT',
  'undefined4', 'undefined2', 'undefined1',
]);
const INT_MAX = 0x7fffffffn;

export function createRangeTestFormTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as RangeTestFormOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const enumValues = o.enumValues ?? {};
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  /** A constant's value and whether its spelling is unsigned, or null. */
  const constantOf = (e: Expression): { v: bigint; u: boolean } | null => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.IntegerLiteral) {
      const l = x as IntegerLiteralExpr;
      if (/l/i.test(l.suffix)) return null;
      return { v: l.value, u: /u/i.test(l.suffix) };
    }
    if (x.kind === NodeKind.Identifier) {
      const v = enumValues[(x as Identifier).name];
      return v === undefined ? null : { v: BigInt(v), u: false };
    }
    if (x.kind === NodeKind.QualifiedId) {
      const n = (x as unknown as { name: { name?: string } }).name.name;
      const v = n ? enumValues[n] : undefined;
      return v === undefined ? null : { v: BigInt(v), u: false };
    }
    return null;
  };
  const constant = constantOf;

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      const shadowed = new Set<string>();
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (localTypes.has(v.name.name)) shadowed.add(v.name.name);
        else localTypes.set(v.name.name, v.type);
      }
      // A static local is storage another call can see change; leave it.
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (v.specifiers.includes('static') || v.specifiers.includes('extern')) shadowed.add(v.name.name);
      }
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      // Every `x - c` / `x + -c` on a named variable, counted by name and value.
      const differences = new Map<string, number>();
      for (const n of findNodesByKind(node.body, NodeKind.BinaryExpr)) {
        const be = n as BinaryExpr;
        if (be.operator !== '-' && be.operator !== '+') continue;
        const l = unwrapParens(be.left);
        if (l.kind !== NodeKind.Identifier) continue;
        let r = unwrapParens(be.right);
        let v: bigint | null = null;
        if (be.operator === '+') {
          if (r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '-') r = unwrapParens((r as UnaryExpr).operand);
          else if (r.kind === NodeKind.IntegerLiteral && (r as IntegerLiteralExpr).value < 0n) { v = -(r as IntegerLiteralExpr).value; }
          else continue;
        }
        if (v === null) { const k = constantOf(r); if (!k) continue; v = k.v; }
        const key = (l as Identifier).name + ':' + v;
        differences.set(key, (differences.get(key) ?? 0) + 1);
      }
      const resolveName = (n: string): string => {
        let cur = n;
        for (let i = 0; i < 8 && !enumTypes.has(cur) && typedefTargets[cur]; i++) cur = typedefTargets[cur];
        return cur;
      };

      /** `x - lo` (or `x + -lo`) as 32-bit unsigned arithmetic on a local or parameter x. */
      const difference = (e: Expression, kUnsigned: boolean): { x: Identifier; lo: Expression; v: bigint } | null => {
        let d = unwrapParens(e);
        let cast = false;
        if (d.kind === NodeKind.CStyleCastExpr) {
          const t = shapeOfNode((d as CStyleCastExpr).type, 0, resolve);
          if (!t || t.stars !== 0 || !UNSIGNED32.has(resolveName(t.base))) return null;
          cast = true;
          d = unwrapParens((d as CStyleCastExpr).expression);
        }
        if (d.kind !== NodeKind.BinaryExpr) return null;
        const be = d as BinaryExpr;
        let lo: Expression; let c: { v: bigint; u: boolean } | null;
        if (be.operator === '-') { lo = be.right; c = constant(lo); }
        else if (be.operator === '+') {
          const r = unwrapParens(be.right);
          if (r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '-') { lo = (r as UnaryExpr).operand; c = constant(lo); }
          else if (r.kind === NodeKind.IntegerLiteral && (r as IntegerLiteralExpr).value < 0n) {
            const l = r as IntegerLiteralExpr;
            lo = Expr.intLiteral(-l.value, l.base === 16 ? 16 : 10);
            c = /l/i.test(l.suffix) ? null : { v: -l.value, u: /u/i.test(l.suffix) };
          } else return null;
        } else return null;
        if (!c || c.v <= 0n) return null;
        const xe = unwrapParens(be.left);
        if (xe.kind !== NodeKind.Identifier) return null;
        const x = xe as Identifier;
        // The same difference read again elsewhere was a value the original kept (zlib's
        // `dist--` before `d_code(dist)` in _tr_tally): a SUB, not a range test.
        if ((differences.get(x.name + ':' + c.v) ?? 0) > 1) return null;
        if (!localTypes.has(x.name) || shadowed.has(x.name)) return null;
        const s = shapeOf(x);
        if (!s || s.stars !== 0) return null;
        const base = resolveName(s.base);
        const u32 = UNSIGNED32.has(base);
        if (!u32 && !NARROW.has(base) && !enumTypes.has(s.base)) return null;
        if (!(cast || c.u || kUnsigned || u32)) return null;
        return { x, lo, v: c.v };
      };

      /** The range form of one conjunct, or null. */
      const rewrite = (e: Expression): Expression | null => {
        let x = unwrapParens(e);
        let negate = false;
        if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!') { negate = true; x = unwrapParens((x as UnaryExpr).operand); }
        if (x.kind !== NodeKind.BinaryExpr) return null;
        const be = x as BinaryExpr;
        // Normalise to `D op K` with the difference on the left.
        const mirror: Record<string, string> = { '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
        let op = be.operator as string; let dSide = be.left; let kSide = be.right;
        if (!(op in mirror)) return null;
        if (constant(be.left) && !constant(be.right)) { op = mirror[op]; dSide = be.right; kSide = be.left; }
        const k0 = constant(kSide);
        if (!k0) return null;
        if (unwrapParens(kSide).kind !== NodeKind.IntegerLiteral) return null;
        // D <= k holds where the branch is taken.
        let k: bigint;
        if (!negate && op === '<=') k = k0.v;
        else if (!negate && op === '<') k = k0.v - 1n;
        else if (negate && op === '>') k = k0.v;
        else if (negate && op === '>=') k = k0.v - 1n;
        else return null;
        if (k < 0n) return null;
        const d = difference(dSide, k0.u);
        if (!d) return null;
        if (d.v + k > INT_MAX) return null;
        const hi: Expression = unwrapParens(d.lo).kind === NodeKind.IntegerLiteral
          ? Expr.intLiteral(d.v + k, 16)
          : (k === 0n ? d.lo : Expr.binary(d.lo, '+', Expr.intLiteral(k, 16)));
        const xr = (): Identifier => ({ ...d.x });
        const lo: Expression = unwrapParens(d.lo).kind === NodeKind.IntegerLiteral ? Expr.intLiteral(d.v, 16) : d.lo;
        return Expr.binary(Expr.binary(xr(), '>=', lo), '&&', Expr.binary(xr(), '<=', hi));
      };

      /** Rewrite the conjuncts of a top-level `&&` chain. */
      const chain = (e: Expression, top: boolean): Expression | null => {
        const x = unwrapParens(e);
        if (x.kind === NodeKind.BinaryExpr && (x as BinaryExpr).operator === '&&') {
          const be = x as BinaryExpr;
          const l = chain(be.left, false); const r = chain(be.right, false);
          if (!l && !r) return null;
          return updateNode(be, { left: l ?? be.left, right: r ?? be.right } as Partial<BinaryExpr>);
        }
        const r = rewrite(x);
        if (!r) return null;
        return top ? r : Expr.paren(r);
      };

      let changed = false;
      const inner = createTransformer({
        visitIfStmt(s: IfStmt): ASTNode | undefined {
          const c = chain(s.condition, true);
          if (!c) return undefined;
          changed = true;
          return updateNode(s, { condition: c } as Partial<IfStmt>);
        },
      });
      const body = inner(node.body);
      return changed ? updateNode(node, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const rangeTestFormPlugin: TransformPlugin = createPlugin(
  'range-test-form',
  'Range Test Form',
  'A one-compare range test (unsigned)(x - lo) <= k on a local guarding its branch goes back to lo <= x && x <= hi, which VC8 folds into ADD x, -lo',
  (options?: PluginOptions) => createRangeTestFormTransformer(options),
  {
    priority: 989.8, // after branch-layout (988) and the case passes (989.5), before the WARNING strip (990): branch-layout ties its decisions to the printed conditions, and the folded test is a branch condition only once the layout is final
    defaultEnabled: true,
    tags: ['matching'],
    version: '1.0.0',
  },
);

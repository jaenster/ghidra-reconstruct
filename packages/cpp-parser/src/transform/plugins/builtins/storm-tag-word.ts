/**
 * Storm Tag Word Plugin
 *
 * Storm's intrusive list link is `{ TSLink *m_prevlink; T *m_next; }`, and `m_next` is a
 * sign-tagged word: the next element's address, or `~&terminator` at the end of the list. The
 * 1997 STORM.H spells the tag with 32-bit casts (`(int)m_next < 0`, `(TSLink *)~(DWORD)m_next`,
 * `(DWORD)this - (DWORD)(m_prevlink->m_next)`); the tree declares the word `intptr_t`, which is
 * `int` on the 32-bit target, and the decompiler copies it into an integer local:
 *
 *     uint32_t uOffset = this->m_next;                intptr_t uOffset = this->m_next;
 *     if ((int)uOffset < 0)                           if (uOffset < 0)
 *       return (TSLink<CMDDEF>*)~uOffset;      ->       return (TSLink<CMDDEF>*)~uOffset;
 *     nLinkOffset = (int)this - prev->m_next;         nLinkOffset = (intptr_t)this - prev->m_next;
 *
 * (TSLink<CMDDEF>::NextLink 006c4040, which VC8 compiles to the original bytes in this form).
 * Three rewrites, each value-preserving on the 32-bit target, where intptr_t IS int:
 *
 *  - A tag local: a local of a 4-byte integer type whose every store is an integer word, which
 *    is tested for its sign (`(int)v < 0`, `v <= 0`) and whose value reaches an address (`(T *)~v`,
 *    `(T *)(v + k)`), is declared `intptr_t`, and the signed casts around its reads go. A signed
 *    `int` local is the same type; an unsigned one is moved only when no read depends on the
 *    signedness (no relational, shift, multiply, divide or remainder of it without a cast).
 *  - A link offset: `(int)p - q->m_next` stored into an `intptr_t` place is spelled with
 *    `(intptr_t)p`; a signed `int` local that receives one is declared `intptr_t` as well.
 *  - A back-link slot: a local `int *` that only holds `D2_StormNextLink(...)` and is only
 *    stored through, `*p = (int)pPrev;`, is declared `T **` for the one pointer type T it stores.
 *
 * A field, a parameter or a global is never retyped: those are Ghidra's.
 */

import { appendFileSync } from 'node:fs';
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CallExpr, ConditionalExpr, Expression, FunctionDecl,
  Identifier, ParameterDecl, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { collectLocalStructs, createExprShape, type ExprShape } from './expr-shape.js';
import { calleeName, bareName, shapeOfNode, unwrapParens, type TypeShape } from './call-arg-cast.js';
import { STORM_NEXT_LINK_HELPER } from './storm-next-link.js';

export interface StormTagWordOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  /** The function as the run's report names it; the body's own name otherwise. */
  reportName?: string;
  /** One line per candidate the pass rewrote or refused. */
  onReport?: (fn: string, line: string) => void;
}

/** The 4-byte integer spellings a tag word is copied into. */
const SIGNED_WORDS = new Set(['int', 'int32_t', 'intptr_t']);
const UNSIGNED_WORDS = new Set(['unsigned int', 'uint32_t', 'uint', 'uintptr_t']);
/** Integer spellings of at most 4 bytes, and the pointer-sized words: a store of one keeps its bits. */
const INTEGER_VALUES = new Set([
  ...SIGNED_WORDS, ...UNSIGNED_WORDS, 'char', 'signed char', 'unsigned char', 'uchar', 'byte', 'BYTE', 'uint8_t',
  'int8_t', 'short', 'unsigned short', 'ushort', 'int16_t', 'uint16_t', 'WORD', 'bool', 'BOOL',
]);
const isIntShape = (s: TypeShape | null): boolean => !!s && s.stars === 0 && INTEGER_VALUES.has(s.base.replace(/^::/, ''));
const isPtrShape = (s: TypeShape | null): boolean => !!s && s.stars > 0;
const isSignedWordCast = (c: CStyleCastExpr): boolean => {
  const s = shapeOfNode(c.type, 0);
  return !!s && s.stars === 0 && SIGNED_WORDS.has(s.base.replace(/^::/, ''));
};
const isZero = (e: Expression): boolean => {
  const u = unwrapParens(e);
  return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 0n;
};

type Chain = ASTNode[];

/** Every identifier named `v` with the chain of nodes above it (outermost first). */
function occurrences(body: ASTNode, v: string): Array<{ id: Identifier; chain: Chain }> {
  const out: Array<{ id: Identifier; chain: Chain }> = [];
  const walk = (x: unknown, chain: Chain): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i, chain); return; }
    if (!x || typeof x !== 'object') return;
    const n = x as ASTNode;
    if (n.kind === NodeKind.Identifier) {
      if ((n as Identifier).name === v) out.push({ id: n as Identifier, chain });
      return;
    }
    const next = [...chain, n];
    for (const [k, val] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      // `p->v` names a member, not the variable.
      if (k === 'member' && n.kind === NodeKind.MemberExpr) continue;
      if (val && typeof val === 'object') walk(val, next);
    }
  };
  walk(body, []);
  return out;
}

/** The nearest ancestor that is not a parenthesis, and the child of it on the path. */
function parentOf(node: ASTNode, chain: Chain, from = chain.length - 1): { parent: ASTNode | null; child: ASTNode; at: number } {
  let child = node;
  let i = from;
  while (i >= 0 && chain[i].kind === NodeKind.ParenExpr) { child = chain[i]; i--; }
  return { parent: i >= 0 ? chain[i] : null, child, at: i };
}

export function createStormTagWordTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as StormTagWordOptions;
  const trace = typeof process !== 'undefined' ? process.env?.STORM_TAG_TRACE : undefined;
  const onReport = o.onReport ?? (trace ? (fn: string, line: string) => appendFileSync(trace, `${fn}\t${line}\n`) : undefined);

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const body = fn.body as unknown as ASTNode;
      const fnName = o.reportName ?? (fn.name as { name?: string })?.name ?? '?';
      const report = (line: string) => onReport?.(fnName, line);

      const localTypes = new Map<string, TypeNode>();
      const declCount = new Map<string, number>();
      const params = new Set<string>();
      for (const p of fn.parameters) {
        const pd = p as ParameterDecl;
        if (!pd.name) continue;
        localTypes.set(pd.name.name, pd.type);
        params.add(pd.name.name);
        declCount.set(pd.name.name, 1);
      }
      const decls = new Map<string, VariableDecl>();
      for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
        decls.set(v.name.name, v);
      }
      const tables = {
        localStructs: collectLocalStructs(body),
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
      };
      // Typedefs unresolved: `intptr_t` is the word here, not `int`.
      const shapeOf: ExprShape = createExprShape(localTypes, tables);
      const isTagField = (e: Expression): boolean => {
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.MemberExpr) return false;
        const s = shapeOf(u);
        return !!s && s.stars === 0 && s.base.replace(/^::/, '') === 'intptr_t';
      };
      /** `(int)p - q->m_next`: the cast and the pointer, or null. */
      const linkOffset = (e: Expression): CStyleCastExpr | null => {
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.BinaryExpr || (u as BinaryExpr).operator !== '-') return null;
        const b = u as BinaryExpr;
        const l = unwrapParens(b.left);
        // Already `(intptr_t)p`: nothing to respell.
        if (l.kind !== NodeKind.CStyleCastExpr || !isSignedWordCast(l as CStyleCastExpr)
          || shapeOfNode((l as CStyleCastExpr).type, 0)?.base === 'intptr_t') return null;
        const inner = unwrapParens((l as CStyleCastExpr).expression);
        const isPtr = inner.kind === NodeKind.ThisExpr || isPtrShape(shapeOf(inner));
        return isPtr && isTagField(b.right) ? l as CStyleCastExpr : null;
      };

      /** Node -> its replacement, applied bottom-up at the end. */
      const replace = new Map<object, (rebuilt: ASTNode) => ASTNode>();
      const retype = new Map<string, TypeNode>();
      const intptrT = () => Type.typedef('intptr_t') as unknown as TypeNode;
      const respell = (c: CStyleCastExpr) => replace.set(c, (r) => updateNode(r as CStyleCastExpr, { type: intptrT() } as Partial<CStyleCastExpr>));

      // Link offsets stored into a place that is already intptr_t (a parameter, a field).
      for (const a of findNodesByKind(body, NodeKind.AssignExpr) as AssignExpr[]) {
        if (a.operator !== '=') continue;
        const cast = linkOffset(a.right);
        if (!cast) continue;
        const target = unwrapParens(a.left);
        const ts = shapeOf(target);
        const tname = target.kind === NodeKind.Identifier ? (target as Identifier).name : null;
        if (ts && ts.stars === 0 && ts.base.replace(/^::/, '') === 'intptr_t') { respell(cast); report(`${emit(target as never)}: link offset: (intptr_t)`); continue; }
        // A local is looked at below; anything else keeps its spelling.
        if (!tname || params.has(tname) || !decls.has(tname)) report(`${tname ?? emit(target as never)}: refused: a link offset stored into ${ts ? `a ${ts.base}` : 'a place of unknown type'} that is not a local`);
      }

      for (const [v, decl] of decls) {
        if (declCount.get(v) !== 1 || params.has(v)) continue;
        const ds = shapeOfNode(decl.type, 0);
        if (!ds) continue;
        const base = ds.base.replace(/^::/, '');
        if (ds.stars === 1 && (SIGNED_WORDS.has(base) || UNSIGNED_WORDS.has(base)) && base !== 'intptr_t' && base !== 'uintptr_t') {
          backLink(v, decl);
          continue;
        }
        if (ds.stars !== 0 || base === 'intptr_t') continue;
        const signed = SIGNED_WORDS.has(base);
        if (!signed && !UNSIGNED_WORDS.has(base)) continue;
        tagLocal(v, decl, signed);
      }

      function tagLocal(v: string, decl: VariableDecl, signed: boolean): void {
        const occ = occurrences(body, v);
        let signTest = false, toAddress = false, offsetStore = false;
        const offsetCasts: CStyleCastExpr[] = [];
        const readCasts: CStyleCastExpr[] = [];
        let why = '';
        const stores: Expression[] = [];
        if (decl.initializer) stores.push(decl.initializer as Expression);
        for (const { id, chain } of occ) {
          if (id === decl.name) continue;
          const { parent, child } = parentOf(id, chain);
          if (parent?.kind === NodeKind.AssignExpr && (parent as AssignExpr).left === child) {
            if ((parent as AssignExpr).operator !== '=') { why = 'updated in place'; break; }
            stores.push((parent as AssignExpr).right);
            continue;
          }
          if (parent?.kind === NodeKind.UnaryExpr && ['&', '++', '--'].includes((parent as UnaryExpr).operator)) { why = (parent as UnaryExpr).operator === '&' ? 'its address is taken' : 'updated in place'; break; }
          if (parent?.kind === NodeKind.PostfixExpr) { why = 'updated in place'; break; }
          // A read: what it is compared with, where its value goes.
          let node: ASTNode = id;
          let at = chain.length - 1;
          let castAround: CStyleCastExpr | null = null;
          // The value reaches an address through its complement or a sign-guarded select.
          let tagPath = false;
          for (;;) {
            const p = parentOf(node, chain, at);
            const par = p.parent;
            if (!par) break;
            if (par.kind === NodeKind.CStyleCastExpr) {
              const c = par as CStyleCastExpr;
              if (node === id && isSignedWordCast(c)) { castAround = c; node = c; at = p.at - 1; continue; }
              if (isPtrShape(shapeOfNode(c.type, 0)) && tagPath) toAddress = true;
              break;
            }
            if (par.kind === NodeKind.BinaryExpr) {
              const b = par as BinaryExpr;
              const other = b.left === p.child ? b.right : b.left;
              if (['<', '<=', '>', '>='].includes(b.operator) && isZero(other) && (node === id || node === castAround)) {
                // A sign test reads the word as signed: through the cast, or declared so.
                if (castAround || signed) signTest = true;
                else if (!signed) { why = `${b.operator} reads its sign unsigned`; }
                break;
              }
              if (['+', '-', '&', '|', '^'].includes(b.operator)) {
                if (isPtrShape(shapeOf(other as Expression))) { if (tagPath) toAddress = true; break; }
                node = par; at = p.at - 1; continue;
              }
              if (['==', '!=', '&&', '||'].includes(b.operator)) break;
              if (!signed && !castAround) why = `${b.operator} reads its sign`;
              break;
            }
            if (par.kind === NodeKind.UnaryExpr) {
              const op = (par as UnaryExpr).operator;
              if (op === '~' || op === '-') { if (op === '~') tagPath = true; node = par; at = p.at - 1; continue; }
              if (op !== '!' && !signed) why = `unary ${op}`;
              break;
            }
            if (par.kind === NodeKind.ConditionalExpr) {
              const cx = par as ConditionalExpr;
              if (cx.condition === p.child) break;
              // `v <= 0 ? 0 : v`: the element address, or none at the terminator.
              if (isZero(cx.thenExpr) && findNodesByKind(cx.condition as unknown as ASTNode, NodeKind.Identifier).some(x => (x as Identifier).name === v)) tagPath = true;
              node = par; at = p.at - 1; continue;
            }
            if (par.kind === NodeKind.AssignExpr) {
              const a = par as AssignExpr;
              if (a.right === p.child && !['=', '+=', '-=', '&=', '|=', '^='].includes(a.operator) && !signed) why = `${a.operator} reads its sign`;
              break;
            }
            if (par.kind === NodeKind.CallExpr && (par as CallExpr).callee === p.child) { why = 'called'; break; }
            break;
          }
          if (why) break;
          if (castAround) readCasts.push(castAround);
        }
        if (why) { report(`${v}: refused: ${why}`); return; }
        for (const s of stores) {
          const lo = linkOffset(s);
          if (lo) { offsetStore = true; offsetCasts.push(lo); continue; }
          const u = unwrapParens(s);
          if (u.kind === NodeKind.IntegerLiteral || (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-' && unwrapParens((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral)) continue;
          // An integer cast of a pointer stores an address, not the word.
          let inner: Expression = u;
          while (inner.kind === NodeKind.CStyleCastExpr) inner = unwrapParens((inner as CStyleCastExpr).expression);
          if (inner !== u && (inner.kind === NodeKind.ThisExpr || isPtrShape(shapeOf(inner)))) {
            why = `a store of a pointer: ${emit(s as never).replace(/\s+/g, ' ').slice(0, 80)}`;
            break;
          }
          if (!isIntShape(shapeOf(s))) {
            why = `a store of ${shapeOf(s) ? `${shapeOf(s)!.base}${'*'.repeat(shapeOf(s)!.stars)}` : 'unknown type'}: ${emit(s as never).replace(/\s+/g, ' ').slice(0, 80)}`;
            break;
          }
        }
        if (why) { report(`${v}: refused: ${why}`); return; }
        // A link offset is the same type for a signed local; a tag word needs both its tests.
        const tag = signTest && toAddress;
        if (!tag && !(offsetStore && signed)) {
          if (signTest || toAddress || offsetStore) report(`${v}: refused: not a tag word (sign test ${signTest}, address ${toAddress}, link offset ${offsetStore})`);
          return;
        }
        retype.set(v, intptrT());
        replace.set(decl, (r) => updateNode(r as VariableDecl, { type: intptrT() } as Partial<VariableDecl>));
        for (const c of readCasts) replace.set(c, (r) => (r as CStyleCastExpr).expression as unknown as ASTNode);
        for (const c of offsetCasts) respell(c);
        report(`${v}: ${tag ? 'tag word' : 'link offset'}: intptr_t (${readCasts.length} casts dropped)`);
      }

      function backLink(v: string, decl: VariableDecl): void {
        const occ = occurrences(body, v);
        if (decl.initializer) { report(`${v}: refused: back-link slot declared with a value`); return; }
        let why = '';
        const writes: CStyleCastExpr[] = [];
        const stores: Array<{ value: Expression; inner: Expression }> = [];
        for (const { id, chain } of occ) {
          if (id === decl.name) continue;
          const { parent, child, at } = parentOf(id, chain);
          if (parent?.kind === NodeKind.AssignExpr && (parent as AssignExpr).left === child) {
            const a = parent as AssignExpr;
            const r = unwrapParens(a.right);
            const call = r.kind === NodeKind.CStyleCastExpr ? unwrapParens((r as CStyleCastExpr).expression) : r;
            const name = call.kind === NodeKind.CallExpr ? calleeName((call as CallExpr).callee) : undefined;
            if (a.operator !== '=' || !name || bareName(name) !== STORM_NEXT_LINK_HELPER || r.kind !== NodeKind.CStyleCastExpr) { why = 'holds another value'; break; }
            writes.push(r as CStyleCastExpr);
            continue;
          }
          // `*p = value;` as a statement.
          if (parent?.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*') {
            const up = parentOf(parent, chain, at - 1);
            if (up.parent?.kind === NodeKind.AssignExpr && (up.parent as AssignExpr).left === up.child && (up.parent as AssignExpr).operator === '='
              && up.at >= 0 && chain[up.at - 1]?.kind === NodeKind.ExprStmt) {
              const value = (up.parent as AssignExpr).right;
              let inner = unwrapParens(value);
              while (inner.kind === NodeKind.CStyleCastExpr && isIntShape(shapeOfNode((inner as CStyleCastExpr).type, 0))) inner = unwrapParens((inner as CStyleCastExpr).expression);
              stores.push({ value, inner });
              continue;
            }
          }
          why = 'read as a value';
          break;
        }
        if (why || writes.length === 0 || stores.length === 0) {
          if (writes.length > 0) report(`${v}: refused: back-link slot ${why || 'never stored through'}`);
          return;
        }
        let pointee: TypeNode | null = null;
        for (const s of stores) {
          const t = s.inner.kind === NodeKind.Identifier ? localTypes.get((s.inner as Identifier).name) ?? null
            : s.inner.kind === NodeKind.CStyleCastExpr ? (s.inner as CStyleCastExpr).type : null;
          if (!t || !isPtrShape(shapeOfNode(t, 0)) || /\bcode\b|\bvoid\b/.test(emit(t as never))) { why = `stores ${emit(s.inner as never).slice(0, 60)}, not a typed pointer`; break; }
          if (pointee && emit(pointee as never) !== emit(t as never)) { why = 'stores two pointer types'; break; }
          pointee = t;
        }
        if (why || !pointee) { report(`${v}: refused: back-link slot ${why}`); return; }
        const slotType = Type.pointer(pointee) as unknown as TypeNode;
        replace.set(decl, (r) => updateNode(r as VariableDecl, { type: Type.pointer(pointee!) as unknown as TypeNode } as Partial<VariableDecl>));
        for (const w of writes) replace.set(w, (r) => updateNode(r as CStyleCastExpr, { type: Type.pointer(pointee!) as unknown as TypeNode } as Partial<CStyleCastExpr>));
        for (const s of stores) replace.set(s.value, () => s.inner as unknown as ASTNode);
        report(`${v}: back-link slot: ${emit(slotType as never)}`);
      }

      if (replace.size === 0) return undefined;
      const rebuild = (x: unknown): unknown => {
        if (Array.isArray(x)) {
          let ch = false;
          const out = x.map(i => { const r = rebuild(i); if (r !== i) ch = true; return r; });
          return ch ? out : x;
        }
        if (!x || typeof x !== 'object') return x;
        const node = x as ASTNode;
        let copy: Record<string, unknown> | null = null;
        for (const [k, val] of Object.entries(node)) {
          if (k === 'location' || k === 'type' || !val || typeof val !== 'object') continue;
          const r = rebuild(val);
          if (r !== val) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
        }
        const out = (copy ?? node) as ASTNode;
        const f = replace.get(node);
        return f ? f(out) : out;
      };
      return updateNode(fn, { body: rebuild(fn.body) } as Partial<FunctionDecl>);
    },
  });
}

export const stormTagWordPlugin: TransformPlugin = {
  id: 'storm-tag-word',
  name: 'Storm Tag Word',
  description:
    'A local copy of a Storm link\'s sign-tagged next word is intptr_t, a link offset is spelled (intptr_t)p, and a back-link slot is T**: the same value and type on the 32-bit target',
  version: '1.0.0',
  // After storm-next-link (975) names the back-link slots, before pointer-word-cast (995)
  // respells what is left.
  priority: 994.6,
  afterSourceForms: true,
  defaultEnabled: true,
  tags: ['type', 'portability'],
  createTransformer: createStormTagWordTransformer,
};

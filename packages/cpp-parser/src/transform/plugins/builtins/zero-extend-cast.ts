/**
 * Zero Extend Cast Plugins
 *
 * VC8 compiles a cast to a narrow unsigned type to a zero extension and a mask to an AND:
 *
 *   (WORD)nPacked       movzx ecx, cx
 *   nPacked & 0xffff    and ecx, 0xffff
 *
 * The decompiler prints both as the mask (it folds ZEXT(SUBPIECE(x)) into an INT_AND that
 * keeps the MOVZX's address). DRLGPATH_GetDirectionLookupFromPacked @0067bbc0 prints
 * `(nSrcPacked & 0xffff)` for a `movzx ecx, cx`; written as `(uint16_t)nSrcPacked` it
 * compiles back to the original. A MOVZX from memory (`movzx ecx, byte ptr [m]`) tells the
 * spellings apart only where the mask is a subscript: VC8 compiles the cast of a dword in
 * memory to that load everywhere, and the mask to the same load everywhere but in an index,
 * where it is `mov ecx, [m]; and ecx, 0xff` (probed for a parameter, a field, a global and a
 * dereference, byte and word, as an index, an addend, a factor, a pushed and a register
 * argument, a compare, a store and a return: only the index differs). Elsewhere the cast
 * would change nothing but the expression tree, and that alone moved the register choice of
 * Interact @00584540 off MATCH. Which instruction each printed mask came from is read off
 * the listing (reconstruct's extract/mask-sites.ts), so two passes:
 *
 *   zero-extend-site  early, on the body as the decompiler printed it: ties each mask
 *                     fact to its `&` node and tags the ones a MOVZX computed with
 *                     the source width
 *   zero-extend-cast  late, on the final types: writes each tagged `E & 0xff` as
 *                     `(uint8_t)E` and `E & 0xffff` as `(uint16_t)E` where that keeps
 *                     the value AND the type of everything around it
 *
 * Both spellings have the value E mod 2^n. They differ in type: the cast promotes to int,
 * the mask has the type of `E & K` under the usual conversions. So the cast is written:
 *
 *   - where `E & K` is an int (E promotes to int, K has no U suffix): the same type;
 *   - otherwise only where the surroundings read nothing but the value, which lies in
 *     [0, 0xffff] either way: an assignment, an initializer, a call argument, a return,
 *     a cast, an index, a shift count, a condition, `!`, `&&`, `||`, `==`, `!=`, a
 *     discarded value; or as the operand of an arithmetic, bitwise or relational operator
 *     whose other operand is an unsigned int, which converts the int cast back to the same
 *     unsigned value, so the operator's type and result do not change;
 *   - anywhere else, where `E & K` is an unsigned int (a 32-bit E that is unsigned, or K with
 *     a U), as `(uint32_t)(uint8_t)E` / `(uint32_t)(uint16_t)E`: the value E mod 2^n and the
 *     type unsigned int, both those of the mask. VC8 compiles the pair to the one MOVZX
 *     (probed: `(x & 0xffff) * n`, `(x & 0xffff) < m`, `a + (x & 0xff)` against the pair,
 *     instruction for instruction; ZLIB_Adler32Combine, the INVENTORY grid checks). Not as
 *     an operand of `<`, `>`, `<=`, `>=`: against a constant VC8 compiles the cast to a byte
 *     compare (`cmp al, 0x4d`) where the original's mask is `movzx ecx, al; cmp ecx, 0x4d`
 *     (HirelingFarWander @005b14e0, MATCH only with the mask), against a variable both
 *     spellings are the same MOVZX.
 *
 * A mask whose E is 64-bit or of a type the pass cannot tell stays, except in a value-only
 * position. A mask an AND computed stays everywhere.
 *
 * The MOVZX tells the spellings apart only where VC8 compiles the mask to an AND. It does not
 * for `x >> 8 & 0xff` (a MOVZX of the second byte already), nor where the shift leaves nothing
 * to clear, so those keep the mask (DRLGOUTDOOR_ValidateSecondaryBorderCell @0067e080 matches
 * only with it). Nor does a store into a name the body also merges a low part into
 * (`v = v & 0xffff0000 | w`, the decompiler's model of a write to AX): VC8 already copies the
 * mask with a MOVZX there, and the cast reshapes the function (RollPrefixes @005c1e80, which
 * RollingItem @005c21a0 calls, matches only with the mask).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, Expression, FunctionDecl, Identifier, IntegerLiteralExpr,
  ParenExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { typeFromSpelling, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import { createFunctionRanges } from './value-range.js';

/** One mask of the decompile and the instruction behind it (extract/mask-sites.ts). */
export interface ZeroExtendMaskSite {
  ord: number;
  k: number;
  mnemonic: string;
  width: number;
}

export interface ZeroExtendSiteOptions extends PluginOptions {
  /** The decompile's INT_AND `&` tokens, in text order, and the byte/word masks among them. */
  count?: number;
  sites?: ZeroExtendMaskSite[];
  onCensus?: (c: { tagged: number; zipped: boolean; untied: number }) => void;
}

export interface ZeroExtendCastOptions extends PluginOptions {
  enumTypes?: string[];
  enumValues?: Record<string, number>;
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Called for each tagged mask: rewritten, or kept and why. */
  onSite?: (site: { line: number; rewritten: boolean; reason: string }) => void;
}

const SKIP_KEYS = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'parent', 'ghidraInfo']);

function children(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const key of Object.keys(n)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') out.push(x as ASTNode); }
    else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') out.push(v as ASTNode);
  }
  return out;
}

/** `E & K` with K a bare 0xff/0xffff literal on either side: E, K and the literal. */
function maskOf(be: BinaryExpr): { value: Expression; k: number; lit: IntegerLiteralExpr } | null {
  if (be.operator !== '&') return null;
  const lit = (e: Expression) => {
    const u = unwrapParens(e);
    if (u.kind !== NodeKind.IntegerLiteral) return null;
    const l = u as IntegerLiteralExpr;
    return l.value === 0xffn || l.value === 0xffffn ? l : null;
  };
  const r = lit(be.right);
  if (r) return { value: be.left, k: Number(r.value), lit: r };
  const l = lit(be.left);
  if (l) return { value: be.right, k: Number(l.value), lit: l };
  return null;
}

const widthOf = (k: number) => (k === 0xff ? 1 : 2);

// ---------------------------------------------------------------------------------------
// zero-extend-site

export function createZeroExtendSiteTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ZeroExtendSiteOptions;
  const sites = o.sites ?? [];
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body || sites.length === 0) return undefined;
      // The body's binary `&` in text order: the operator sits just before its right operand.
      const ands: BinaryExpr[] = [];
      const find = (n: ASTNode) => {
        if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '&') ands.push(n as BinaryExpr);
        for (const c of children(n)) find(c);
      };
      find(node.body);
      const located = ands.every(a => a.right.location?.start?.offset !== undefined);
      if (!located) { o.onCensus?.({ tagged: 0, zipped: false, untied: sites.length }); return undefined; }
      ands.sort((a, b) => a.right.location!.start!.offset! - b.right.location!.start!.offset!);

      // A register source must be the mask's width; a memory source (width 0) is a load of
      // the byte or word the constant keeps, the only zero extension an INT_AND at the MOVZX
      // can print.
      const movzx = (s: ZeroExtendMaskSite) => s.mnemonic === 'MOVZX' && (s.width === widthOf(s.k) || s.width === 0);
      const tie = new Map<BinaryExpr, ZeroExtendMaskSite>();
      const zipped = ands.length === o.count;
      if (zipped) {
        for (const s of sites) {
          const be = ands[s.ord];
          const m = be && maskOf(be);
          if (m && m.k === s.k) tie.set(be, s);
        }
      } else {
        // Without the position zip, a constant whose every printed mask came from the same
        // instruction kind is tied to the body's masks with that constant, if as many.
        for (const k of [0xff, 0xffff]) {
          const of = sites.filter(s => s.k === k);
          const nodes = ands.filter(a => maskOf(a)?.k === k);
          if (of.length === 0 || of.length !== nodes.length) continue;
          if (!of.every(movzx)) continue;
          nodes.forEach((n, i) => tie.set(n, of[i]));
        }
      }

      const tagged = new Map<ASTNode, ASTNode>();
      for (const [be, s] of tie) {
        if (!movzx(s)) continue;
        tagged.set(be, { ...be, ghidraInfo: { ...(be.ghidraInfo ?? {}), zeroExtendWidth: s.width || widthOf(s.k), zeroExtendMemory: s.width === 0 } } as ASTNode);
      }
      o.onCensus?.({ tagged: tagged.size, zipped, untied: sites.length - tie.size });
      if (!tagged.size) return undefined;
      return updateNode(node, { body: replaceNodes(node.body, tagged) } as Partial<FunctionDecl>);
    },
  });
}

/** Rebuild `root` with each node in `map` replaced, copying only the paths that change. */
function replaceNodes(root: ASTNode, map: Map<ASTNode, ASTNode>): ASTNode {
  const direct = map.get(root);
  const base = direct ?? root;
  let copy: Record<string, unknown> | null = null;
  for (const key of Object.keys(base)) {
    if (SKIP_KEYS.has(key)) continue;
    const v = (base as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map(x => {
        if (!x || typeof x !== 'object' || typeof (x as ASTNode).kind !== 'string') return x;
        const r = replaceNodes(x as ASTNode, map);
        if (r !== x) changed = true;
        return r;
      });
      if (changed) (copy ??= { ...base })[key] = next;
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
      const r = replaceNodes(v as ASTNode, map);
      if (r !== v) (copy ??= { ...base })[key] = r;
    }
  }
  return (copy ?? base) as unknown as ASTNode;
}

// ---------------------------------------------------------------------------------------
// zero-extend-cast

/** Constants that keep the upper part of a register and clear the low byte or word. */
const KEEP_HIGH = new Set([0xffff0000n, 0xffffff00n]);

function stripCasts(e: Expression): Expression {
  let x = unwrapParens(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unwrapParens((x as CStyleCastExpr).expression);
  return x;
}

/**
 * Why the mask and the cast compile to the same instructions, so the MOVZX does not tell
 * the two spellings apart; null when they differ. VC8 (probed):
 *
 *   x >> 8 & 0xff       movzx r, ah  /  movzx r, byte ptr [m + 1]   - the mask already
 *                       zero-extends the second byte; the cast is shr + movzx
 *   x >> 24 & 0xff      shr only, either spelling: the mask clears nothing
 *   x >> 16 & 0xffff    shr only, either spelling
 */
function sameInstruction(value: Expression, k: number): string | null {
  const v = unwrapParens(value);
  if (v.kind !== NodeKind.BinaryExpr || (v as BinaryExpr).operator !== '>>') return null;
  const c = unwrapParens((v as BinaryExpr).right);
  if (c.kind !== NodeKind.IntegerLiteral) return null;
  const n = (c as IntegerLiteralExpr).value;
  if (k === 0xff && n === 8n) return 'second byte: the mask compiles to the MOVZX';
  if (k === 0xff && n === 24n || k === 0xffff && n === 16n) return 'the shift leaves nothing to clear';
  return null;
}

const VALUE_BINARY = new Set(['==', '!=', '&&', '||']);
const RELATIONAL = new Set(['<', '>', '<=', '>=']);
const ABSORBING_BINARY = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<', '>', '<=', '>=']);
const CONDITION_KINDS = new Set<string>([NodeKind.IfStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.SwitchStmt]);

/** A cast operand that needs no parentheses. */
function primary(e: Expression): boolean {
  return [
    NodeKind.Identifier, NodeKind.IntegerLiteral, NodeKind.ParenExpr, NodeKind.MemberExpr,
    NodeKind.SubscriptExpr, NodeKind.CallExpr, NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr,
    NodeKind.QualifiedId, NodeKind.PostfixExpr,
  ].includes(e.kind as NodeKind);
}

export function createZeroExtendCastTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as ZeroExtendCastOptions;
  const enumTypes = new Set(o.enumTypes ?? []);
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;
      const parents = new Map<ASTNode, ASTNode>();
      const masks: BinaryExpr[] = [];
      const index = (n: ASTNode) => {
        if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).ghidraInfo?.zeroExtendWidth) masks.push(n as BinaryExpr);
        for (const c of children(n)) { parents.set(c, n); index(c); }
      };
      index(node.body);
      if (!masks.length) return undefined;

      const ranges = createFunctionRanges(node, {
        enumTypes: o.enumTypes,
        enumValues: o.enumValues,
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });
      const isUnsignedInt = (e: Expression) => ranges.rangeAt(e)?.unsigned === true;

      /** Whether the position of `x` (whose parent is `p`) reads nothing but its value. */
      const valueOnly = (x: ASTNode, p: ASTNode | undefined): boolean => {
        if (!p) return false;
        switch (p.kind) {
          case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.FunctionalCastExpr:
          case NodeKind.ReturnStmt: case NodeKind.ExprStmt:
            return true;
          case NodeKind.CallExpr: return (p as unknown as { callee: ASTNode }).callee !== x;
          case NodeKind.SubscriptExpr: return (p as unknown as { index: ASTNode }).index === x;
          case NodeKind.VariableDecl: {
            const t = (p as VariableDecl).type as unknown as { name?: unknown };
            return (p as VariableDecl).initializer === x && t?.name !== 'auto';
          }
          case NodeKind.ConditionalExpr: return (p as unknown as { condition: ASTNode }).condition === x;
          case NodeKind.UnaryExpr: return (p as unknown as { operator: string }).operator === '!';
          case NodeKind.CommaExpr: {
            const es = (p as unknown as { expressions: ASTNode[] }).expressions;
            return es[es.length - 1] !== x;
          }
          case NodeKind.AssignExpr: {
            const a = p as AssignExpr;
            if (a.right !== x) return false;
            if (a.operator === '=' || a.operator === '<<=' || a.operator === '>>=') return true;
            return ABSORBING_BINARY.has(a.operator.slice(0, -1)) && isUnsignedInt(a.left);
          }
          case NodeKind.BinaryExpr: {
            const b = p as BinaryExpr;
            if (VALUE_BINARY.has(b.operator)) return true;
            if (b.operator === '<<' || b.operator === '>>') return b.right === x;
            if (ABSORBING_BINARY.has(b.operator)) return isUnsignedInt((b.left === x ? b.right : b.left) as Expression);
            return false;
          }
          default:
            return CONDITION_KINDS.has(p.kind) && (p as unknown as { condition: ASTNode }).condition === x;
        }
      };

      // Names whose upper part the body keeps while it replaces the low one:
      // `v = v & 0xffff0000 | w` is the decompiler's model of a write to AX or AL.
      const merged = new Set<string>();
      const findMerges = (n: ASTNode) => {
        if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '&') {
          const b = n as BinaryExpr;
          for (const [v, k] of [[b.left, b.right], [b.right, b.left]] as const) {
            const kk = unwrapParens(k), vv = unwrapParens(stripCasts(v));
            if (kk.kind === NodeKind.IntegerLiteral && KEEP_HIGH.has((kk as IntegerLiteralExpr).value) && vv.kind === NodeKind.Identifier) {
              merged.add((vv as Identifier).name);
            }
          }
        }
        for (const c of children(n)) findMerges(c);
      };
      findMerges(node.body);
      /** The mask is stored whole into one of those names. */
      const mergedRegister = (x: ASTNode, p: ASTNode | undefined): boolean => {
        if (p?.kind === NodeKind.AssignExpr && (p as AssignExpr).right === x) {
          const l = unwrapParens((p as AssignExpr).left);
          return l.kind === NodeKind.Identifier && merged.has((l as Identifier).name);
        }
        if (p?.kind === NodeKind.VariableDecl && (p as VariableDecl).initializer === x) return merged.has((p as VariableDecl).name.name);
        return false;
      };

      const replace = new Map<ASTNode, ASTNode>();
      for (const be of masks) {
        const m = maskOf(be);
        const line = be.location?.start?.line ?? 0;
        if (!m || widthOf(m.k) !== be.ghidraInfo!.zeroExtendWidth) { o.onSite?.({ line, rewritten: false, reason: 'not a mask' }); continue; }
        // The mask with its own parentheses; the cast takes their place unless they hold a
        // postfix operand (`(x & 0xff)[p]`), where the innermost pair stays.
        let x: ASTNode = be;
        while (parents.get(x)?.kind === NodeKind.ParenExpr) x = parents.get(x)!;
        const p = parents.get(x);
        const postfixOperand = x !== be && !!p && (
          p.kind === NodeKind.SubscriptExpr && (p as unknown as { array: ASTNode }).array === x
          || p.kind === NodeKind.MemberExpr || p.kind === NodeKind.PostfixExpr
          || p.kind === NodeKind.CallExpr && (p as unknown as { callee: ASTNode }).callee === x);
        const same = sameInstruction(m.value, m.k);
        if (same) { o.onSite?.({ line, rewritten: false, reason: same }); continue; }
        if (mergedRegister(x, p)) { o.onSite?.({ line, rewritten: false, reason: 'stored into a register the code merges a part into' }); continue; }
        if (be.ghidraInfo!.zeroExtendMemory && !(p?.kind === NodeKind.SubscriptExpr && (p as unknown as { index: ASTNode }).index === x)) {
          o.onSite?.({ line, rewritten: false, reason: 'a load outside an index: the mask compiles to the same MOVZX' });
          continue;
        }
        const r = ranges.rangeAt(m.value);
        const unsuffixed = !/u/i.test(m.lit.suffix ?? '');
        let reason: string;
        if (r && !r.unsigned && unsuffixed) reason = 'int';
        else if (valueOnly(x, p)) reason = 'value';
        else if (r && !RELATIONAL.has((p as BinaryExpr | undefined)?.operator ?? '')) reason = 'unsigned';
        else { o.onSite?.({ line, rewritten: false, reason: r ? 'unsigned in a relational compare' : 'type unknown' }); continue; }
        const v = unwrapParens(m.value);
        const operand: Expression = primary(v) ? v : {
          kind: NodeKind.ParenExpr, expression: v, location: v.location, leadingTrivia: [], trailingTrivia: [],
        } as ParenExpr;
        const castTo = (spelling: string, e: Expression) => ({
          kind: NodeKind.CStyleCastExpr, type: typeFromSpelling(spelling)!, expression: e, location: be.location,
          leadingTrivia: [], trailingTrivia: [],
        }) as unknown as CStyleCastExpr;
        const narrow = castTo(m.k === 0xff ? 'uint8_t' : 'uint16_t', operand);
        // `E & K` of a 32-bit E is an unsigned int here (E unsigned, or K with a U): the cast
        // back to uint32_t keeps that type, and VC8 compiles the pair to the one MOVZX.
        const cast = reason === 'unsigned' ? castTo('uint32_t', narrow) : narrow;
        replace.set(postfixOperand ? be : x, cast);
        o.onSite?.({ line, rewritten: true, reason });
      }
      if (!replace.size) return undefined;
      return updateNode(node, { body: replaceNodes(node.body, replace) } as Partial<FunctionDecl>);
    },
  });
}

export const zeroExtendSitePlugin: TransformPlugin = createPlugin(
  'zero-extend-site',
  'Zero Extend Site',
  'Tags each byte/word mask the original computed with a MOVZX',
  (options?: PluginOptions) => createZeroExtendSiteTransformer(options),
  {
    priority: 3, // before any pass reshapes the printed masks the facts are tied to
    defaultEnabled: true,
    tags: ['matching'],
    version: '1.0.0',
  },
);

export const zeroExtendCastPlugin: TransformPlugin = createPlugin(
  'zero-extend-cast',
  'Zero Extend Cast',
  'A byte/word mask the original computed with a MOVZX is the cast to uint8_t/uint16_t, where that keeps value and type',
  (options?: PluginOptions) => createZeroExtendCastTransformer(options),
  {
    priority: 622, // after the cast and compare passes: needs the final local types
    defaultEnabled: true,
    tags: ['matching'],
    version: '1.0.0',
  },
);

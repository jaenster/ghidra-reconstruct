/**
 * The steering checks: forms that buy a VC8 byte-match without being the algorithm.
 *
 * A hand-owned body is landed because it matches; a match that holds only through an
 * attribute, a qualifier, a pragma, a raw address or a temporary whose only effect is the
 * order of two loads is a match by non-algorithmic means, and that is a failure. Each check
 * here reports such a site in one body. Keyword-shaped checks read the lexer's tokens (the
 * parser rejects `register`, `__asm` and `__declspec`, and a body it rejects must still be
 * checked); everything structural reads the AST.
 */

import { Lexer, NodeKind, TokenKind, getChildren } from '@ghidra-mcp/cpp-parser';
import { signature } from '../ast.js';
import type { GlobalDecl } from '../tree.js';
import { bindSites, scanSites } from '../../ratchet/refs.js';
import type { SymbolIndex } from '../../ratchet/symbol-index.js';
import {
  bindBody, castOperand, effectsOf, emptyEffects, isArrayDecl, isCastNode, isPointerTypeNode, isScalarDecl,
  isStaticDecl, lineOf, mergeEffects, reorderConflicts, typeMentions, unparen,
  type Body, type Bound, type Effects, type Use, type Var,
} from './body.js';
import type { Vocabulary } from './vocabulary.js';

type AnyNode = Record<string, any>;

export interface SteerFinding {
  check: string;
  /** Line in the body text (1-based, relative to the text). */
  line: number;
  subject: string;
  detail: string;
  /** Location-free identity of the site. */
  sig: string;
  /** The `steer-ok:` reason that exempts the site. */
  exempt?: string;
}

export interface SteerEnv {
  vocabulary: Vocabulary;
  /** Site indices a stored body bound when it was captured (a ratchet record's bindings). */
  storedBindings?: Set<number>;
  /** Whether the generator's own output spells a name (a generated inline helper, a data symbol). */
  generated?: (name: string) => boolean;
  /** File-static helpers defined in the body's own file (a hand-written header inline above it). */
  fileHelpers?: Set<string>;
  /** The tree's symbol index and the scope the body is printed in, for unbound-identifier. */
  index?: SymbolIndex;
  scope?: string[];
  /** The tree's globals, for the type of a name the body does not declare. */
  globals?: Map<string, GlobalDecl>;
}

export interface SteerCheck {
  id: string;
  blurb: string;
  run(body: Body, env: SteerEnv, bound: Bound | null): SteerFinding[];
}

export const NOINLINE_SPELLINGS = ['noinline', '__noinline__', 'D2_NOINLINE'];
export const FORCEINLINE_SPELLINGS = ['__forceinline', 'always_inline', '__always_inline__', 'D2_FORCEINLINE'];
export const ASM_SPELLINGS = ['__asm', '__asm__', '_asm', 'asm', '_emit'];
/** `#pragma` names that change code generation for the functions after them. */
export const CODEGEN_PRAGMAS = new Set([
  'optimize', 'inline_depth', 'inline_recursion', 'auto_inline', 'intrinsic', 'function', 'check_stack',
  'runtime_checks', 'strict_gs_check', 'code_seg', 'GCC', 'clang', 'loop', 'float_control', 'fenv_access',
  'fp_contract', 'vtordisp', 'safebuffers', 'optimize_for_size',
]);

/** The image's address range: 1.14d Game.exe is mapped at 0x400000 and ends below 0x800000. */
export const IMAGE_LOW = 0x400000n;
export const IMAGE_HIGH = 0x800000n;

const INTEGER_TYPEDEFS = new Set([
  'uint32_t', 'int32_t', 'uint16_t', 'int16_t', 'uint8_t', 'int8_t', 'uintptr_t', 'intptr_t', 'size_t', 'ptrdiff_t',
  'DWORD', 'WORD', 'BYTE', 'UINT', 'INT', 'LONG', 'ULONG', 'BOOL', 'DWORD_PTR', 'UINT_PTR', 'INT_PTR', 'LONG_PTR',
  'ULONG_PTR', 'int64_t', 'uint64_t',
]);

function finding(check: string, line: number, subject: string, detail: string, sig: string): SteerFinding {
  return { check, line, subject, detail, sig };
}

function tokenCheck(id: string, blurb: string, spellings: string[], what: string): SteerCheck {
  return {
    id, blurb,
    run(body, env) {
      const set = new Set([...spellings, ...(env.vocabulary.macroSpellings.get(id) ?? [])]);
      const out: SteerFinding[] = [];
      const n = new Map<string, number>();
      for (const t of body.tokens) {
        if (!set.has(t.text)) continue;
        const k = n.get(t.text) ?? 0;
        n.set(t.text, k + 1);
        out.push(finding(id, t.line, t.text, `${what} \`${t.text}\``, `${t.text}#${k}`));
      }
      return out;
    },
  };
}

export const noinlineCheck = tokenCheck('noinline', 'noinline attribute', NOINLINE_SPELLINGS, 'inlining forced off by');
export const forceinlineCheck = tokenCheck('forceinline', 'forced inlining outside the vocabulary header', FORCEINLINE_SPELLINGS, 'inlining forced on by');

export const asmCheck: SteerCheck = {
  id: 'inline-asm', blurb: 'inline assembly',
  run(body) {
    const out: SteerFinding[] = [];
    let k = 0;
    for (const t of body.tokens) {
      if (!ASM_SPELLINGS.includes(t.text)) continue;
      out.push(finding('inline-asm', t.line, t.text, `inline assembly \`${t.text}\``, `${t.text}#${k++}`));
    }
    return out;
  },
};

export const registerCheck: SteerCheck = {
  id: 'register-keyword', blurb: 'the register storage class',
  run(body) {
    const out: SteerFinding[] = [];
    let k = 0;
    for (let i = 0; i < body.tokens.length; i++) {
      const t = body.tokens[i];
      if (t.kind !== TokenKind.Register) continue;
      const next = body.tokens.slice(i + 1, i + 6).map(x => x.text).join(' ');
      out.push(finding('register-keyword', t.line, 'register', `\`register ${next}\``, `register#${k++}`));
    }
    return out;
  },
};

/** The pragma's name: the first identifier after `#pragma`, read with the lexer. */
export function pragmaName(directive: string): string | null {
  let toks;
  try {
    toks = new Lexer(directive.replace(/^\s*#/, ''), {}).tokenize();
  } catch {
    return null;
  }
  const words = toks.filter((t: any) => t.kind !== TokenKind.EOF).map((t: any) => t.text);
  if (words[0] !== 'pragma') return null;
  return words[1] ?? null;
}

export const pragmaCheck: SteerCheck = {
  id: 'optimize-pragma', blurb: 'code-generation pragmas',
  run(body) {
    const out: SteerFinding[] = [];
    let k = 0;
    for (const d of body.directives) {
      const name = pragmaName(d.text);
      if (!name || !CODEGEN_PRAGMAS.has(name)) continue;
      out.push(finding('optimize-pragma', d.line, name, `\`${d.text.trim()}\``, `${name}#${k++}`));
    }
    return out;
  },
};

/** Every node of the body with its parent. */
function walkWithParent(root: AnyNode, visit: (n: AnyNode, parent: AnyNode | null) => void): void {
  const rec = (n: AnyNode | null | undefined, parent: AnyNode | null) => {
    if (!n || typeof n !== 'object' || typeof n.kind !== 'string') return;
    visit(n, parent);
    for (const c of getChildren(n as any)) rec(c as AnyNode, n);
  };
  rec(root, null);
}

/** The parent past any parentheses. */
function parentPastParens(n: AnyNode, parents: Map<AnyNode, AnyNode | null>): { parent: AnyNode | null; child: AnyNode } {
  let child = n;
  let p = parents.get(n) ?? null;
  while (p?.kind === NodeKind.ParenExpr) { child = p; p = parents.get(p) ?? null; }
  return { parent: p, child };
}

function parentMapOf(root: AnyNode): Map<AnyNode, AnyNode | null> {
  const m = new Map<AnyNode, AnyNode | null>();
  walkWithParent(root, (n, p) => m.set(n, p));
  return m;
}

export const volatileCheck: SteerCheck = {
  id: 'volatile', blurb: 'volatile locals and volatile accesses',
  run(body, _env, bound) {
    const out: SteerFinding[] = [];
    if (!body.fn || !bound) {
      // Unparsed: every `volatile` token counts.
      let k = 0;
      for (const t of body.tokens) if (t.text === 'volatile') out.push(finding('volatile', t.line, 'volatile', 'volatile in a body the parser could not read', `volatile#${k++}`));
      return out;
    }
    for (const v of bound.vars) {
      if (v.kind !== 'local' || !typeMentions(v.decl.type, 'volatile')) continue;
      out.push(finding('volatile', lineOf(v.decl), v.name, `local \`${v.name}\` declared volatile`, `local:${v.name}`));
    }
    walkWithParent(body.fn.body, (n) => {
      if (!isCastNode(n) || !typeMentions(n.type, 'volatile')) return;
      const op = unparen(castOperand(n));
      // `*(volatile uint8_t*)0x0 = 0` is the original's deliberate fault: a constant address is faithful.
      if (op?.kind === NodeKind.IntegerLiteral) return;
      out.push(finding('volatile', lineOf(n), 'cast', 'access forced through a volatile cast', signature(n)));
    });
    return out;
  },
};

/** The declared type of a simple expression, when the body or the tree can say. */
function exprType(e: AnyNode | null | undefined, bound: Bound, env: SteerEnv): AnyNode | null {
  const x = unparen(e);
  if (!x) return null;
  if (x.kind === NodeKind.Identifier) {
    const v = bound.ref.get(x);
    if (v) return v.decl.type ?? null;
    return env.globals?.get(x.name)?.type ?? null;
  }
  if (x.kind === NodeKind.QualifiedId) {
    const last = x.name?.name;
    return last ? env.globals?.get(last)?.type ?? null : null;
  }
  if (isCastNode(x)) return x.type ?? null;
  if (x.kind === NodeKind.UnaryExpr && x.operator === '&') return { kind: NodeKind.PointerType, pointee: null, qualifiers: [] };
  return null;
}

function isPointerExpr(e: AnyNode | null | undefined, bound: Bound, env: SteerEnv): boolean {
  const x = unparen(e);
  if (x?.kind === NodeKind.Identifier) {
    const v = bound.ref.get(x);
    if (v && isArrayDecl(v.decl)) return true;
  }
  return isPointerTypeNode(exprType(x, bound, env));
}

function isIntegerType(t: AnyNode | null | undefined): boolean {
  let x = t;
  while (x?.kind === NodeKind.QualifiedType) x = x.type;
  if (!x) return false;
  if (x.kind === NodeKind.BuiltinType) return !['void', 'float', 'double', 'bool'].includes(x.name);
  if (x.kind === NodeKind.TypedefType) {
    const n = x.name?.name ?? x.name?.name?.name;
    return typeof n === 'string' && INTEGER_TYPEDEFS.has(n);
  }
  return false;
}

function inImage(n: AnyNode): boolean {
  return n?.kind === NodeKind.IntegerLiteral && typeof n.value === 'bigint' && n.value >= IMAGE_LOW && n.value < IMAGE_HIGH;
}

/**
 * A hex literal in the image range that is not a bit pattern: one or two set bits, or one
 * contiguous run of ones, is a mask or a flag; anything else there is an address.
 */
export function addressShaped(n: AnyNode): boolean {
  if (!inImage(n) || !String(n.raw).toLowerCase().startsWith('0x')) return false;
  const v: bigint = n.value;
  let bits = 0;
  for (let x = v; x; x &= x - 1n) bits++;
  if (bits <= 2) return false;
  let low = v;
  while (!(low & 1n)) low >>= 1n;
  return ((low + 1n) & low) !== 0n;
}

export const rawAddressCheck: SteerCheck = {
  id: 'raw-address', blurb: '1.14d image address literals used as pointers',
  run(body, env, bound) {
    if (!body.fn || !bound) return [];
    const out: SteerFinding[] = [];
    const parents = parentMapOf(body.fn.body);
    for (const [n] of parents) {
      if (!inImage(n)) continue;
      const { parent, child } = parentPastParens(n, parents);
      let how: string | null = null;
      if (parent && isCastNode(parent) && isPointerTypeNode(parent.type)) how = 'cast to a pointer';
      else if (parent?.kind === NodeKind.CallExpr && parent.callee === child) how = 'called';
      else if (parent?.kind === NodeKind.BinaryExpr && ['==', '!=', '<', '>', '<=', '>='].includes(parent.operator)) {
        const other = parent.left === child ? parent.right : parent.left;
        if (isPointerExpr(other, bound, env)) how = 'compared with a pointer';
      } else if (parent?.kind === NodeKind.AssignExpr && parent.right === child && isPointerExpr(parent.left, bound, env)) how = 'stored into a pointer';
      else if (parent?.kind === NodeKind.VariableDecl && parent.initializer === child && isPointerTypeNode(parent.type)) how = 'initialises a pointer';
      if (!how && addressShaped(n)) how = 'written as a constant (not a bit pattern)';
      if (!how) continue;
      out.push(finding('raw-address', lineOf(n), n.raw, `1.14d address ${n.raw} ${how}`, signature(parent ?? n)));
    }
    return out;
  },
};

export const pointerIntCastCheck: SteerCheck = {
  id: 'pointer-int-cast', blurb: 'pointer-to-integer casts whose integer value is never used',
  run(body, env, bound) {
    if (!body.fn || !bound) return [];
    const out: SteerFinding[] = [];
    const parents = parentMapOf(body.fn.body);
    const isPtrToInt = (c: AnyNode | null | undefined) =>
      !!c && isCastNode(c) && isIntegerType(c.type) && isPointerExpr(castOperand(c), bound, env);
    for (const [n] of parents) {
      if (!isPtrToInt(n)) continue;
      const { parent, child } = parentPastParens(n, parents);
      let how: string | null = null;
      if (!parent) continue;
      if ((parent.kind === NodeKind.IfStmt || parent.kind === NodeKind.WhileStmt || parent.kind === NodeKind.DoWhileStmt) && parent.condition === child) how = 'only tested for null';
      else if (parent.kind === NodeKind.ForStmt && parent.condition === child) how = 'only tested for null';
      else if (parent.kind === NodeKind.ConditionalExpr && parent.condition === child) how = 'only tested for null';
      else if (parent.kind === NodeKind.UnaryExpr && parent.operator === '!') how = 'only tested for null';
      else if (parent.kind === NodeKind.BinaryExpr && (parent.operator === '&&' || parent.operator === '||')) how = 'only tested for null';
      else if (parent.kind === NodeKind.BinaryExpr && (parent.operator === '==' || parent.operator === '!=')) {
        const other = unparen(parent.left === child ? parent.right : parent.left);
        if (other?.kind === NodeKind.IntegerLiteral && other.value === 0n) how = 'only compared with 0';
        else if (isPtrToInt(other)) how = 'compared with another pointer cast to an integer';
      } else if (isCastNode(parent) && isPointerTypeNode(parent.type)) how = 'cast straight back to a pointer';
      if (!how) continue;
      out.push(finding('pointer-int-cast', lineOf(n), 'cast', `pointer cast to an integer and ${how}`, signature(parent)));
    }
    return out;
  },
};

// ---- dataflow: dead stores and single-use temporaries ----------------------------------------

interface StmtPos {
  list: AnyNode[];
  index: number;
}

/** The compound statement list and index holding `stmt` directly. */
function positionOf(stmt: AnyNode, parents: Map<AnyNode, AnyNode | null>): StmtPos | null {
  const p = parents.get(stmt);
  if (p?.kind === NodeKind.CompoundStmt) return { list: p.statements, index: p.statements.indexOf(stmt) };
  return null;
}

const JUMPS = new Set<string>([NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt]);

function containsKind(n: AnyNode, kinds: Set<string>): boolean {
  let found = false;
  walkWithParent(n, (x) => { if (kinds.has(x.kind)) found = true; });
  return found;
}

function mentions(n: AnyNode, v: Var, bound: Bound): boolean {
  let found = false;
  walkWithParent(n, (x) => { if (x.kind === NodeKind.Identifier && bound.ref.get(x) === v) found = true; });
  return found;
}

/** The statement whose direct child of a compound statement holds node `n`. */
function enclosingStatement(n: AnyNode, parents: Map<AnyNode, AnyNode | null>): AnyNode | null {
  let x: AnyNode | null = n;
  while (x) {
    const p: AnyNode | null = parents.get(x) ?? null;
    if (p?.kind === NodeKind.CompoundStmt) return x;
    x = p;
  }
  return null;
}

function isLiteralInit(e: AnyNode | null | undefined): boolean {
  const x = unparen(e);
  if (!x) return false;
  if (x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.CharLiteral || x.kind === NodeKind.FloatingLiteral ||
      x.kind === NodeKind.BoolLiteral || x.kind === NodeKind.NullptrLiteral) return true;
  if (x.kind === NodeKind.UnaryExpr && x.operator === '-' ) return isLiteralInit(x.operand);
  if (isCastNode(x)) return isLiteralInit(castOperand(x));
  return x.kind === NodeKind.Identifier && (x.name === 'NULL' || x.name === 'nullptr' || x.name === 'FALSE' || x.name === 'TRUE');
}

export const deadStoreCheck: SteerCheck = {
  id: 'dead-store', blurb: 'stores no path reads',
  run(body, _env, bound) {
    if (!body.fn || !bound) return [];
    const out: SteerFinding[] = [];
    const parents = parentMapOf(body.fn);
    for (const v of bound.vars) {
      if (v.kind !== 'local' || isStaticDecl(v) || !isScalarDecl(v) || v.escapes.length) continue;
      if (typeMentions(v.decl.type, 'volatile')) continue;
      const init = v.decl.initializer;
      // Never read at all: every store to it is dead.
      if (!v.reads.length && (v.writes.length || init)) {
        const n = v.writes.length + (init ? 1 : 0);
        out.push(finding('dead-store', lineOf(v.decl), v.name, `\`${v.name}\` is stored ${n} time(s) and never read`, `never-read:${v.name}`));
        continue;
      }
      // A store the next statement that names the variable overwrites without reading it.
      const stores: Array<{ stmt: AnyNode; literal: boolean }> = [];
      if (init && v.stmt) stores.push({ stmt: v.stmt, literal: isLiteralInit(init) });
      for (const w of v.writes) {
        if (w.partial || w.at?.kind !== NodeKind.AssignExpr || w.at.operator !== '=') continue;
        const st = parents.get(w.at);
        if (st?.kind === NodeKind.ExprStmt) stores.push({ stmt: st, literal: isLiteralInit(w.at.right) });
      }
      for (const s of stores) {
        const pos = positionOf(s.stmt, parents);
        if (!pos) continue;
        for (let j = pos.index + 1; j < pos.list.length; j++) {
          const st = pos.list[j];
          if (containsKind(st, JUMPS) || st.kind === NodeKind.ReturnStmt && !mentions(st, v, bound)) break;
          if (!mentions(st, v, bound)) continue;
          const e = st.kind === NodeKind.ExprStmt ? st.expression : null;
          if (e?.kind === NodeKind.AssignExpr && e.operator === '=' && unparen(e.left)?.kind === NodeKind.Identifier &&
              bound.ref.get(unparen(e.left)!) === v && !mentions(e.right, v, bound)) {
            const what = s.literal ? 'constant store' : 'store';
            out.push(finding('dead-store', lineOf(s.stmt), v.name,
              `${what} to \`${v.name}\` overwritten at line ${lineOf(st) + body.firstLine - 1} before any read`, `overwritten:${v.name}:${signature(s.stmt)}`));
          }
          break;
        }
      }
    }
    return out;
  },
};

/** Expression positions evaluated exactly once whenever their statement runs. */
function onceEvaluated(path: AnyNode[], from: number): boolean {
  for (let i = from; i < path.length - 1; i++) {
    const p = path[i];
    const c = path[i + 1];
    switch (p.kind) {
      case NodeKind.WhileStmt:
      case NodeKind.DoWhileStmt:
      case NodeKind.ForStmt:
      case NodeKind.LambdaExpr:
      case NodeKind.SwitchStmt:
        if (p.kind === NodeKind.SwitchStmt && p.condition === c) break;
        return false;
      case NodeKind.IfStmt:
        if (p.condition !== c) return false;
        break;
      case NodeKind.BinaryExpr:
        if ((p.operator === '&&' || p.operator === '||') && p.right === c) return false;
        break;
      case NodeKind.ConditionalExpr:
        if (p.condition !== c) return false;
        break;
    }
  }
  return true;
}

/**
 * Everything evaluated between a definition at `defPos` and the use at the end of `usePath`,
 * in two parts: the statements in between (`between`), and in the statement holding the use,
 * every subexpression other than the path to the use (`siblings`: their order relative to the
 * use is the compiler's choice).
 */
function regionEffects(defPos: StmtPos, useStmtIndex: number, usePath: AnyNode[], bound: Bound): { between: Effects; siblings: Effects } {
  const between = emptyEffects();
  const siblings = emptyEffects();
  for (let j = defPos.index + 1; j < useStmtIndex; j++) mergeEffects(between, effectsOf(defPos.list[j], bound));
  const useStmt = defPos.list[useStmtIndex];
  const start = usePath.indexOf(useStmt);
  for (let i = start; i < usePath.length - 1; i++) {
    const p = usePath[i];
    const c = usePath[i + 1];
    if (p.kind === NodeKind.CompoundStmt) {
      // A nested block: its statements before the use are statements in between.
      for (const s of p.statements) { if (s === c) break; mergeEffects(between, effectsOf(s, bound)); }
      continue;
    }
    if (p.kind === NodeKind.IfStmt || p.kind === NodeKind.SwitchStmt) continue;
    if (p.kind === NodeKind.AssignExpr && p.operator === '=' && p.right === c) {
      const l = unparen(p.left);
      if (l?.kind === NodeKind.Identifier || l?.kind === NodeKind.QualifiedId) continue;
    }
    for (const s of getChildren(p as any) as AnyNode[]) {
      if (s === c || !s || typeof s !== 'object') continue;
      if (p.kind === NodeKind.DeclStmt && p.declarations.indexOf(s) > p.declarations.indexOf(c)) continue;
      if (p.kind === NodeKind.VariableDecl && s !== p.initializer) continue;
      // The name of the function called is not evaluated as a value.
      if (p.kind === NodeKind.CallExpr && s === p.callee) {
        const cn = unparen(s);
        if (cn?.kind === NodeKind.QualifiedId || cn?.kind === NodeKind.Identifier && !bound.ref.get(cn)) continue;
      }
      mergeEffects(siblings, effectsOf(s, bound));
    }
  }
  return { between, siblings };
}

function describeMove(r: Effects): string {
  const parts: string[] = [];
  if (r.calls) parts.push(`${r.calls} call(s)`);
  if (r.globalReads || r.ptrReads || r.escReads) parts.push('memory loads');
  if (r.localReads.size) parts.push(`reads of ${[...r.localReads].map(v => v.name).slice(0, 3).join(', ')}`);
  if (r.localWrites.size) parts.push(`stores to ${[...r.localWrites].map(v => v.name).slice(0, 3).join(', ')}`);
  return parts.join(', ') || 'other evaluations';
}

export const singleUseTempCheck: SteerCheck = {
  id: 'single-use-temp', blurb: 'single-use temporaries that only move an evaluation',
  run(body, _env, bound) {
    if (!body.fn || !bound) return [];
    const out: SteerFinding[] = [];
    const parents = parentMapOf(body.fn);
    for (const v of bound.vars) {
      if (v.kind !== 'local' || isStaticDecl(v) || !isScalarDecl(v) || v.escapes.length) continue;
      if (typeMentions(v.decl.type, 'volatile')) continue;
      if (v.reads.length !== 1) continue;
      // The definition: the initializer with no other store, or the one plain store with no initializer.
      let defStmt: AnyNode | null = null;
      let init: AnyNode | null = null;
      if (v.decl.initializer && !v.writes.length) { defStmt = v.stmt; init = v.decl.initializer; }
      else if (!v.decl.initializer && v.writes.length === 1 && v.writes[0].at?.kind === NodeKind.AssignExpr &&
               v.writes[0].at.operator === '=' && !v.writes[0].partial) {
        const st = parents.get(v.writes[0].at);
        if (st?.kind === NodeKind.ExprStmt) { defStmt = st; init = v.writes[0].at.right; }
      }
      if (!defStmt || !init) continue;
      const defPos = positionOf(defStmt, parents);
      if (!defPos) continue;
      const use: Use = v.reads[0];
      const usePath = [...use.path, use.id];
      const useStmt = defPos.list.find((s, j) => j > defPos.index && usePath.includes(s));
      if (!useStmt) continue;
      const useIndex = defPos.list.indexOf(useStmt);
      if (!onceEvaluated(usePath, usePath.indexOf(useStmt))) continue;
      const ie = effectsOf(init, bound);
      // A constant names a value; there is no evaluation to move.
      const readsSomething = ie.localReads.size || ie.globalReads || ie.ptrReads || ie.escReads;
      if (ie.sideEffects || !readsSomething) continue;
      // A call result: a call is an ordering point the compiler keeps, and holding its result
      // in a named local is how the value gets a name. Only loads and arithmetic are moved.
      if (ie.calls) continue;
      const { between, siblings } = regionEffects(defPos, useIndex, usePath, bound);
      const at = (n: AnyNode) => lineOf(n) + body.firstLine - 1;
      // The statements in between that the initializer could be moved below: everything up
      // to the first one that stores what it reads (or calls, against a load).
      let movable = 0;
      let blocked = false;
      for (let j = defPos.index + 1; j < useIndex; j++) {
        const eff = effectsOf(defPos.list[j], bound);
        if (reorderConflicts(ie, eff)) { blocked = true; break; }
        if (eff.evals) movable++;
      }
      if (!blocked && reorderConflicts(ie, siblings)) blocked = true;
      let detail: string;
      if (blocked) {
        // The temporary is needed, but it sits above statements it does not depend on.
        if (!movable) continue;
        detail = `\`${v.name}\` (read once, line ${at(use.id)}) is computed ${movable} statement(s) before anything stops it moving down; only its placement is chosen`;
      } else {
        // Hoisted above other statements, or out of an expression ahead of a call or a memory
        // access the compiler could otherwise order either way. Pulling a value out of an
        // expression whose other operands are register locals moves nothing.
        if (!between.evals && !siblings.memEvals) continue;
        const r = mergeEffects(mergeEffects(emptyEffects(), between), siblings);
        detail = `\`${v.name}\` is read once (line ${at(use.id)}) and only moves its evaluation ahead of ${describeMove(between.evals ? r : siblings)}`;
      }
      out.push(finding('single-use-temp', lineOf(v.decl.initializer ? v.decl : defStmt), v.name, detail,
        `temp:${v.name}:${signature(init)}`));
    }
    return out;
  },
};

export const unboundIdentifierCheck: SteerCheck = {
  id: 'unbound-identifier', blurb: 'names the tree index does not bind',
  run(body, env) {
    if (!env.index) return [];
    const scan = scanSites(body.text);
    if (!scan) return [];
    const bindings = bindSites(scan, env.index, env.scope ?? []);
    const lambdaParams = new Set<string>();
    if (body.fn) walkWithParent(body.fn.body, (n) => {
      if (n.kind === NodeKind.LambdaExpr) for (const p of n.parameters ?? []) if (p?.name?.name) lambdaParams.add(p.name.name);
      // A body-local enum's enumerators are the body's own names.
      if (n.kind === NodeKind.EnumeratorDecl && n.name?.name) lambdaParams.add(n.name.name);
    });
    const out: SteerFinding[] = [];
    const seen = new Map<string, number>();
    scan.sites.forEach((s, i) => {
      if (bindings[i] || s.kind === 'member' || env.storedBindings?.has(i)) return;
      // `sizeof(g)` parses g as a type: a global or function the index binds is still bound.
      if (s.kind === 'type' && env.index!.resolve(s.parts, s.isGlobal, env.scope ?? [])) return;
      const name = s.parts.join('::');
      const last = s.parts[s.parts.length - 1];
      if (!s.isGlobal && s.parts.length === 1 && (scan.locals.has(last) || scan.paramTypes.has(last) || lambdaParams.has(last))) return;
      if (env.vocabulary.accepts(s.parts)) return;
      if (env.globals?.has(last)) return;
      if (env.generated?.(last)) return;
      if (s.parts.length === 1 && env.fileHelpers?.has(last)) return;
      const k = seen.get(name) ?? 0;
      seen.set(name, k + 1);
      const line = body.text.slice(0, s.start).split('\n').length;
      out.push(finding('unbound-identifier', line, name, `${s.kind} \`${name}\` is not in the tree's index or the vocabulary`, `${s.kind}:${name}#${k}`));
    });
    return out;
  },
};

export const BODY_CHECKS: SteerCheck[] = [
  noinlineCheck, forceinlineCheck, volatileCheck, asmCheck, pragmaCheck, registerCheck,
  rawAddressCheck, pointerIntCastCheck, deadStoreCheck, singleUseTempCheck, unboundIdentifierCheck,
];

/** Checks the run adds outside a body: a body it cannot read, and edits to anchors or prototypes. */
export const UNPARSED_CHECK_ID = 'unparsed-body';
export const PROTOTYPE_CHECK_ID = 'prototype-edit';
export const ANCHOR_CHECK_ID = 'anchor-edit';

export const ALL_STEERING_CHECK_IDS = [...BODY_CHECKS.map(c => c.id), UNPARSED_CHECK_ID, PROTOTYPE_CHECK_ID, ANCHOR_CHECK_ID];

/** A `// steer-ok: <reason>` comment on the site's line or the line above exempts it. */
export function exemptions(body: Body): Map<number, string> {
  const out = new Map<number, string>();
  for (const c of body.comments) {
    const text = c.text.replace(/^\/\/|^\/\*|\*\/$/g, '').trim();
    if (!text.startsWith('steer-ok:')) continue;
    const reason = text.slice('steer-ok:'.length).trim();
    if (reason) out.set(c.line, reason);
  }
  return out;
}

/**
 * A name the body does not declare reads memory unless something says it is not a variable:
 * the index binding it as a function, an enumerator or a type, or the vocabulary (a macro
 * constant, a C library name). A name nothing knows is taken for a variable.
 */
export function variablePredicate(env: SteerEnv): (parts: string[], isGlobal: boolean) => boolean {
  return (parts, isGlobal) => {
    const last = parts[parts.length - 1];
    if (env.globals?.has(last)) return true;
    const r = env.index?.resolve(parts, isGlobal, env.scope ?? []);
    if (r) return r.k === 'gl';
    return !env.vocabulary.accepts(parts);
  };
}

/** Run every body check on one body; exempted sites carry their reason. */
export function lintBody(body: Body, env: SteerEnv, checks: SteerCheck[] = BODY_CHECKS): SteerFinding[] {
  const out: SteerFinding[] = [];
  if (!body.fn) {
    out.push(finding(UNPARSED_CHECK_ID, 1, 'body', `the parser cannot read this body (${body.parseErrors[0] ?? '?'}); nothing structural was checked`, 'unparsed'));
  } else if (body.parseErrors.length) {
    out.push(finding(UNPARSED_CHECK_ID, 1, 'body', `parts of this body did not parse (${body.parseErrors[0]})`, 'partial'));
  }
  const bound = body.fn ? bindBody(body.fn) : null;
  if (bound) bound.isVariable = variablePredicate(env);
  for (const c of checks) out.push(...c.run(body, env, bound));
  const ex = exemptions(body);
  for (const f of out) {
    const r = ex.get(f.line) ?? ex.get(f.line - 1);
    if (r) f.exempt = r;
  }
  return out;
}

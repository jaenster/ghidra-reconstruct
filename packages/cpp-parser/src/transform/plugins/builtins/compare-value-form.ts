/**
 * Compare Value Form Plugin
 *
 * The other direction of compare-branch-form.ts: comparisons the decompiler prints as branch
 * conditions or folds into logic, which the original computed as values. VC8 keeps a
 * comparison as a value only when the source holds it as one, so each rewrite writes the
 * holder the instructions show (extract/compare-sites.ts: `pos`, `use`, `sz`):
 *
 *  - One compare the decompiler printed as several tests (`pos` `b`, `use` `s`, every row of
 *    one op address): the original held the 0 or 1 in a register and tested it at each use,
 *    `int bNeg = *p == '-'; if (bNeg) p++; ... if (bNeg) n = -n;` (SStrToInt 00413ac0, `xor
 *    eax, eax; cmp byte ptr [edx], 0x2d; sete al; mov esi, eax`). Written as one local read
 *    by every test; `int` when the SETcc's register was zeroed whole (`sz` `1`), `bool` when
 *    not. It is declared right after the statement of the block that set the operands, where
 *    the original computed it (GetCurrentItemOnBodyLocation 0063e490 sets it right after the
 *    call that returns the handedness), else before the first test. The operands are locals
 *    whose address is not taken and that nothing from there to the last test writes, so the
 *    local holds the value every test would compute; a label in that stretch, where another
 *    path could enter past the declaration, leaves the tests alone.
 *
 *  - A mask of a comparison the original materialised with SBB (`use` `c`): `-(T)(C)` is VC8's
 *    `setcc; neg`, and the original's `neg; sbb` (or `cmp; sbb`) is the select
 *    `C ? (T)-1 : 0` (Storm's `VALIDATE(p)`, `intrn_valresult &= p ? -1 : 0`; SFILE_EnumFilesInternal
 *    00419180). The value is the same: all ones exactly when C holds.
 *
 *  - The decompiler folds two masks ANDed together into one test of `&&`: `-(T)(A && B) & X`,
 *    which the generator turns into `A && B ? X : 0` and VC8 compiles with branches. When every
 *    comparison of A and B was materialised by SBB, none was branched on, so the original read
 *    X whatever A and B were; the select becomes the AND of the masks,
 *    `(A ? -1 : 0) & (B ? -1 : 0) & X` (SBmpDecodeImage 006c6a80). The value is X when both
 *    hold and 0 otherwise, as before; X must have no side effect and no comparison of its own
 *    that the original branched on. Where X reads through a pointer a leaf tests
 *    (SMemFindNextHeap 004124b0, `pHeapDetails->dwSize`), one expression lets VC8 drop that
 *    leaf's test, which the original's separate masks kept: left for the check block.
 *
 * A test is tied to its rows by operator family and its operands' fingerprints: `v:<name>`,
 * `c:<hex>`, `f:<field>` (rows of the newer script), and `e` for any other operand, which then
 * has to match the row's `e` exactly. Every row a test fits must agree, or the test is left.
 * Without facts, or with rows of an older script, the pass does nothing.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, Expression, FunctionDecl,
  Identifier, IntegerLiteralExpr, MemberExpr, ParenExpr, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import type { Transformer } from '../../transformer.js';
import { cloneNode } from '../../transformer.js';
import { Decl, Expr, Stmt, Type } from '../../../ast/factory.js';

export interface CompareValueFormOptions extends PluginOptions {
  /** The function's compare-sites rows (extract/compare-sites.ts), tab separated, one per line. */
  compareSites?: string;
  onSite?: (e: { kind: 'shared-test' | 'mask' | 'mask-and'; text: string }) => void;
}

interface Row { op: string; opcode: string; at: string; prints: string[]; pos: string; use: string; sz: string }

function parseRows(s: string | undefined): Row[] {
  if (!s) return [];
  const rows: Row[] = [];
  for (const line of s.split('\n')) {
    const f = line.split('\t');
    if (f.length < 22 || f[2] === '-') continue;
    const prints = [f[6], f[7]];
    if (f.length >= 27) for (let k = 0; k < 2; k++) if (f[24 + k] && f[24 + k] !== '-') prints[k] = 'f:' + f[24 + k];
    rows.push({ op: f[1], opcode: f[2], at: f[8], prints, pos: f[18], use: f[19], sz: f.length >= 27 ? f[23] : '-' });
  }
  return rows;
}

const CMP = new Set(['<', '>', '<=', '>=', '==', '!=']);
const EQ = new Set(['==', '!=']);

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
    else if (e.kind === NodeKind.CStyleCastExpr) e = (e as CStyleCastExpr).expression;
    else return e;
  }
}

function operandPrint(e: Expression): string {
  const u = unwrap(e);
  if (u.kind === NodeKind.Identifier) return 'v:' + (u as Identifier).name;
  if (u.kind === NodeKind.IntegerLiteral) return 'c:' + (u as IntegerLiteralExpr).value.toString(16);
  if (u.kind === NodeKind.CharLiteral) return 'c:' + Number((u as unknown as { value: number }).value).toString(16);
  if (u.kind === NodeKind.MemberExpr && (u as MemberExpr).member.kind === NodeKind.Identifier) return 'f:' + ((u as MemberExpr).member as Identifier).name;
  return 'e';
}

/** A comparison (or `!x`, which the rows print as `x == 0`): family and both operands' prints. */
function testOf(e: Expression): { eq: boolean; prints: string[]; node: BinaryExpr | UnaryExpr } | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.BinaryExpr && CMP.has((u as BinaryExpr).operator)) {
    const b = u as BinaryExpr;
    return { eq: EQ.has(b.operator), prints: [operandPrint(b.left), operandPrint(b.right)], node: b };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '!') {
    return { eq: true, prints: [operandPrint((u as UnaryExpr).operand), 'c:0'], node: u as UnaryExpr };
  }
  return null;
}

/** Whether a row prints the test's two operands, in either order; at least one must name something. */
function fits(r: Row, t: { eq: boolean; prints: string[] }): boolean {
  if (EQ.has(r.op) !== t.eq) return false;
  if (!t.prints.some((p) => p.startsWith('v:') || p.startsWith('f:'))) return false;
  const [a, b] = t.prints;
  return (r.prints[0] === a && r.prints[1] === b) || (r.prints[0] === b && r.prints[1] === a);
}

/** Whether an `e` test fits with only a literal beside it: the masks of `*p != 0`. */
function fitsLoose(r: Row, t: { eq: boolean; prints: string[] }): boolean {
  if (EQ.has(r.op) !== t.eq) return false;
  const [a, b] = t.prints;
  return (r.prints[0] === a && r.prints[1] === b) || (r.prints[0] === b && r.prints[1] === a);
}

function walk(node: unknown, visit: (n: ASTNode, parent: ASTNode | null, key: string) => void, parent: ASTNode | null = null, key = ''): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) walk(c, visit, parent, key); return; }
  const n = node as ASTNode;
  if (n.kind !== undefined) visit(n, parent, key);
  for (const k of Object.keys(n)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'parent') continue;
    const c = (n as unknown as Record<string, unknown>)[k];
    if (c && typeof c === 'object') walk(c, visit, n.kind !== undefined ? n : parent, k);
  }
}

function hasEffect(e: ASTNode): boolean {
  let hit = false;
  walk(e, (n) => {
    if (n.kind === NodeKind.CallExpr || n.kind === NodeKind.AssignExpr || n.kind === NodeKind.PostfixExpr) hit = true;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) hit = true;
    if (n.kind === NodeKind.BinaryExpr && ['/', '%'].includes((n as BinaryExpr).operator)) hit = true;
  });
  return hit;
}

/** Replace `from` with `to` wherever the tree holds it (by identity). */
function replaceNode(root: ASTNode, from: ASTNode, to: Expression): boolean {
  let done = false;
  const visit = (n: unknown): void => {
    if (done || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (let i = 0; i < n.length && !done; i++) { if (n[i] === from) { n[i] = to; done = true; } else visit(n[i]); }
      return;
    }
    const o = n as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'parent') continue;
      if (o[k] === from) { o[k] = to; done = true; return; }
      if (o[k] && typeof o[k] === 'object') visit(o[k]);
      if (done) return;
    }
  };
  visit(root);
  return done;
}

class Rewriter {
  private declared = new Set<string>();
  private addressed = new Set<string>();
  private used = new Set<string>();

  constructor(private fn: FunctionDecl, private rows: Row[], private opts: CompareValueFormOptions) {
    for (const p of fn.parameters) {
      const n = (p as unknown as { name?: Identifier | null }).name;
      if (n) this.declared.add(n.name);
    }
    walk(fn.body, (n) => {
      if (n.kind === NodeKind.VariableDecl) this.declared.add((n as VariableDecl).name.name);
      if (n.kind === NodeKind.Identifier) this.used.add((n as Identifier).name);
      if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
        const o = unwrap((n as UnaryExpr).operand);
        if (o.kind === NodeKind.Identifier) this.addressed.add((o as Identifier).name);
      }
    });
  }

  private fresh(base: string): string {
    let name = base;
    while (this.used.has(name) || this.declared.has(name)) name += '_';
    this.used.add(name); this.declared.add(name);
    return name;
  }

  run(): void {
    this.sharedTests();
    this.masks();
  }

  /** The block and statement index of every enclosing block of `target`, outermost first. */
  private pathTo(target: ASTNode): { blk: CompoundStmt; i: number }[] | null {
    const path: { blk: CompoundStmt; i: number }[] = [];
    const find = (n: unknown): boolean => {
      if (!n || typeof n !== 'object') return false;
      if (n === target) return true;
      if (Array.isArray(n)) return n.some(find);
      const node = n as ASTNode;
      if (node.kind === NodeKind.CompoundStmt) {
        const ss = (node as CompoundStmt).statements;
        for (let i = 0; i < ss.length; i++) {
          path.push({ blk: node as CompoundStmt, i });
          if (find(ss[i])) return true;
          path.pop();
        }
        return false;
      }
      for (const k of Object.keys(node)) {
        if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'parent') continue;
        const c = (node as unknown as Record<string, unknown>)[k];
        if (c && typeof c === 'object' && find(c)) return true;
      }
      return false;
    };
    return find(this.fn.body) ? path : null;
  }

  private sharedTests(): void {
    const groups = new Map<string, Row[]>();
    for (const r of this.rows) {
      if (r.at === '-' || !/^[0-9a-f]+$/i.test(r.at)) continue;
      groups.set(r.at, [...(groups.get(r.at) ?? []), r]);
    }
    for (const [at, group] of groups) {
      if (group.length < 2 || !group.every((r) => r.pos === 'b' && r.use === 's' && EQ.has(r.op))) continue;
      const sz = new Set(group.map((r) => r.sz));
      if (sz.size !== 1 || !(sz.has('1') || sz.has('0'))) continue;
      const kind: 'int' | 'bool' = sz.has('1') ? 'int' : 'bool';
      const want = { eq: true, prints: group[0].prints };
      // Every printed test of these operands is one of the group's, and the group's only.
      const tests: { node: BinaryExpr | UnaryExpr; op: string }[] = [];
      walk(this.fn.body, (n) => {
        const t = testOf(n as Expression);
        if (!t || unwrap(n as Expression) !== n) return;
        if (!fits(group[0], t)) return;
        tests.push({ node: t.node, op: t.node.kind === NodeKind.UnaryExpr ? '==' : (t.node as BinaryExpr).operator });
      });
      if (tests.length !== group.length) continue;
      if (this.rows.some((r) => r.at !== at && fits(r, want))) continue;
      // The operands: locals whose address is not taken, or literals.
      const names: string[] = [];
      let ok = true;
      for (const p of group[0].prints) {
        if (p.startsWith('v:')) {
          const x = p.slice(2);
          if (!this.declared.has(x) || this.addressed.has(x)) ok = false;
          names.push(x);
        } else if (!p.startsWith('c:')) ok = false;
      }
      if (!ok) continue;
      // The innermost block holding every test, and the stretch of its statements they span.
      const paths = tests.map((t) => this.pathTo(t.node));
      if (paths.some((p) => !p || p.length === 0)) continue;
      let depth = 0;
      while (paths.every((p) => p!.length > depth && p![depth].blk === paths[0]![depth].blk)) depth++;
      if (depth === 0) continue;
      const blk = paths[0]![depth - 1].blk;
      const first = Math.min(...paths.map((p) => p![depth - 1].i));
      const last = Math.max(...paths.map((p) => p![depth - 1].i));
      const span = blk.statements.slice(first, last + 1);
      let clean = true;
      for (const s of span) {
        walk(s, (n) => {
          if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) clean = false;
          if (n.kind === NodeKind.AssignExpr) {
            const l = unwrap((n as AssignExpr).left);
            if (l.kind === NodeKind.Identifier && names.includes((l as Identifier).name)) clean = false;
          }
          if (n.kind === NodeKind.VariableDecl && names.includes((n as VariableDecl).name.name)) clean = false;
          if (n.kind === NodeKind.PostfixExpr || (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator))) {
            let hit = false;
            walk(n, (m) => { if (m.kind === NodeKind.Identifier && names.includes((m as Identifier).name)) hit = true; });
            if (hit) clean = false;
          }
        });
      }
      if (!clean) continue;
      // The original computes the value once its operands are final: right after the statement
      // of this block that sets one, when only statements that leave them alone follow it.
      let ins = first;
      for (let j = first - 1; j >= 0; j--) {
        const s = blk.statements[j];
        let label = false;
        let sets = false;
        walk(s, (n) => {
          if (n.kind === NodeKind.LabelStmt || n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt) label = true;
          if (n.kind === NodeKind.AssignExpr) {
            const l = unwrap((n as AssignExpr).left);
            if (l.kind === NodeKind.Identifier && names.includes((l as Identifier).name)) sets = true;
          }
          if (n.kind === NodeKind.VariableDecl && names.includes((n as VariableDecl).name.name)) sets = true;
          if (n.kind === NodeKind.PostfixExpr || (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator))) sets = true;
        });
        if (label) break;
        if (sets) {
          const plain = s.kind === NodeKind.DeclStmt
            || (s.kind === NodeKind.ExprStmt && unwrap((s as unknown as { expression: Expression }).expression).kind === NodeKind.AssignExpr);
          if (plain) ins = j + 1;
          break;
        }
      }
      // The value the op computes: INT_EQUAL is `==`, INT_NOTEQUAL is `!=`.
      const base = group[0].opcode === 'INT_NOTEQUAL' ? '!=' : '==';
      const model = tests[0].node;
      const operands: [Expression, Expression] = model.kind === NodeKind.UnaryExpr
        ? [(model as UnaryExpr).operand, Expr.intLiteral(0)]
        : [(model as BinaryExpr).left, (model as BinaryExpr).right];
      const name = this.fresh(kind === 'bool' ? 'bTest' : 'nTest');
      const value = Expr.binary(cloneNode(operands[0]), base, cloneNode(operands[1]));
      for (const t of tests) {
        const ref = t.op === base ? Expr.identifier(name) : Expr.unary('!', Expr.identifier(name));
        replaceNode(this.fn.body as ASTNode, t.node, ref);
      }
      blk.statements.splice(ins, 0, Stmt.declStmt([Decl.variable(name, kind === 'bool' ? Type.bool() : Type.int(), value)]));
      this.opts.onSite?.({ kind: 'shared-test', text: name });
    }
  }

  /** The rows a value-position test fits, `e` operands matched exactly; null when none. */
  private valueRows(e: Expression): Row[] | null {
    const t = testOf(e);
    if (!t) return null;
    const tied = t.prints.some((p) => p.startsWith('v:') || p.startsWith('f:'));
    const fit = this.rows.filter((r) => r.pos === 'v' && (tied ? fits(r, t) : fitsLoose(r, t)));
    return fit.length > 0 ? fit : null;
  }

  private materialised(e: Expression): boolean {
    const fit = this.valueRows(e);
    return !!fit && fit.every((r) => r.use === 'c');
  }

  /** `C ? (T)-1 : 0`, T the mask's type (the negation's cast), else int. */
  private select(c: Expression, type: TypeNode | null): Expression {
    const t = type ? cloneNode(type) : Type.int();
    return Expr.paren(Expr.conditional(unwrap(c), Expr.cast(t, Expr.neg(Expr.intLiteral(1))), Expr.intLiteral(0)));
  }

  private masks(): void {
    const sites: { n: ASTNode; to: Expression; kind: 'mask' | 'mask-and' }[] = [];
    walk(this.fn.body, (n) => {
      // -(T)(C) and -(C)
      if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '-') {
        let o = (n as UnaryExpr).operand;
        while (o.kind === NodeKind.ParenExpr) o = (o as ParenExpr).expression;
        const type = o.kind === NodeKind.CStyleCastExpr ? (o as CStyleCastExpr).type : null;
        const c = type ? (o as CStyleCastExpr).expression : o;
        if (testOf(c) && !hasEffect(c) && this.materialised(c)) sites.push({ n, to: this.select(c, type), kind: 'mask' });
        return;
      }
      // A && B ? X : 0
      if (n.kind === NodeKind.ConditionalExpr) {
        const q = n as ConditionalExpr;
        const z = unwrap(q.elseExpr);
        if (z.kind !== NodeKind.IntegerLiteral || (z as IntegerLiteralExpr).value !== 0n) return;
        const leaves: Expression[] = [];
        const chain = (e: Expression): void => {
          const u = (() => { let x = e; while (x.kind === NodeKind.ParenExpr) x = (x as ParenExpr).expression; return x; })();
          if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') { chain((u as BinaryExpr).left); chain((u as BinaryExpr).right); } else leaves.push(u);
        };
        chain(q.condition);
        if (leaves.length < 2 || hasEffect(q.condition) || hasEffect(q.thenExpr)) return;
        // A bare name is the decompiler's `name != 0`.
        const asTest = (l: Expression): Expression => (unwrap(l).kind === NodeKind.Identifier ? Expr.binary(l, '!=', Expr.intLiteral(0)) : l);
        if (!leaves.every((l) => testOf(asTest(l)) && this.materialised(asTest(l)))) return;
        // X branched on nothing of its own.
        let branched = false;
        walk(q.thenExpr, (m) => {
          if (m.kind === NodeKind.ConditionalExpr || (m.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((m as BinaryExpr).operator))) branched = true;
          const t = testOf(m as Expression);
          if (t && unwrap(m as Expression) === m) {
            const fit = this.valueRows(m as Expression);
            if (fit && fit.some((r) => r.use === 'j')) branched = true;
          }
        });
        if (branched) return;
        // X reading through a name a leaf tests: in one expression VC8 drops that leaf's test
        // (the read proves the pointer valid), which the original's separate masks kept. The
        // block of checks is the form there; left.
        const tested = new Set<string>();
        for (const l of leaves) walk(l, (m) => { if (m.kind === NodeKind.Identifier) tested.add((m as Identifier).name); });
        let readsTested = false;
        walk(q.thenExpr, (m) => {
          let base: Expression | null = null;
          if (m.kind === NodeKind.MemberExpr && (m as MemberExpr).isArrow) base = (m as MemberExpr).object;
          if (m.kind === NodeKind.UnaryExpr && (m as UnaryExpr).operator === '*') base = (m as UnaryExpr).operand;
          if (m.kind === NodeKind.SubscriptExpr) base = (m as unknown as { array: Expression }).array;
          if (base && unwrap(base).kind === NodeKind.Identifier && tested.has((unwrap(base) as Identifier).name)) readsTested = true;
        });
        if (readsTested) return;
        let acc: Expression = this.select(asTest(leaves[0]), null);
        for (const l of leaves.slice(1)) acc = Expr.binary(acc, '&', this.select(asTest(l), null));
        sites.push({ n, to: Expr.paren(Expr.binary(acc, '&', Expr.paren(q.thenExpr))), kind: 'mask-and' });
      }
    });
    for (const s of sites) {
      if (replaceNode(this.fn.body as ASTNode, s.n, s.to)) this.opts.onSite?.({ kind: s.kind, text: '' });
    }
  }
}

export const compareValueFormPlugin: TransformPlugin = {
  id: 'compare-value-form',
  name: 'Compare Value Form',
  description: 'Writes a comparison the original computed as a value in the holder its instructions show, from the compare sites',
  version: '0.1.0',
  defaultEnabled: true,
  priority: 989.9915,
  tags: ['codegen', 'vc8'],
  createTransformer(options?: PluginOptions): Transformer {
    const opts = (options ?? {}) as CompareValueFormOptions;
    const rows = parseRows(opts.compareSites);
    return (ast: ASTNode) => {
      if (rows.length === 0) return ast;
      const fns: FunctionDecl[] = [];
      walk(ast, (n) => { if (n.kind === NodeKind.FunctionDecl) fns.push(n as FunctionDecl); });
      for (const fn of fns) if (fn.body) new Rewriter(fn, rows, opts).run();
      return ast;
    };
  },
};

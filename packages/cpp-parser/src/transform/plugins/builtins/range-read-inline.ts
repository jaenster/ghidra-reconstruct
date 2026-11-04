/**
 * Range Read Inline Plugin
 *
 * VC8 folds a two-sided range test against constants on a local, `x >= lo && x <= hi`,
 * into one unsigned compare (`ADD x, -lo; CMP x, hi - lo; JA`), and Ghidra prints that fold
 * back as a difference (`x - lo <= k`, see range-test-form). On a read of memory, `p->n >=
 * lo && p->n <= hi`, it keeps the two compares. So where the decompile prints two compares
 * of a local against constants, the local cannot be the original's: it is Ghidra's name for
 * a value the original read from memory at each compare (CSE gave both compares one
 * register). Compiled with the local, VC8 folds the test the original does not have
 * (SOUND_DebugPrintChannels 004baa50: `nSoundId = pChan->nSoundId; if (nSoundId >= 0xb76
 * && nSoundId <= 0x1230)` folds to `lea; cmp; ja` where the original has `cmp; jl; cmp; jg`;
 * the same in D2WINEDITBOX_FilterLetterChar 004fe790 and STATES_DispatchRemFunc 004d9f40).
 *
 * The local is read back as the memory it was given:
 *
 *     T x = p->f;                         if (p->f >= lo && p->f <= hi)
 *     if (x >= lo && x <= hi)        ->      g(p->f);
 *       g(x);
 *
 * when
 *   - x is a local, not static, declared in the block it is given its value in, and given
 *     exactly one value there, `T x = M;` or `x = M;` after a declaration without one, and
 *     no other write anywhere; its address is never taken;
 *   - M reads memory through names only: a member chain (`p->f`, `p->a.b`, `s.f`), `*p`, or
 *     a global, rooted at a name that is not x; M's type is x's type, so every read of M
 *     has the value x had;
 *   - x is the operand of a two-sided range test against integer constants, `x >= lo && x
 *     <= hi` (either bound strict, either operand order), as the condition of an `if` or a
 *     conjunct of it;
 *   - every read of x lies after the assignment in that block and before any call, any
 *     store to memory and any write of a name M is rooted at, in evaluation order: so M
 *     still holds x's value at each read. A read inside a loop that also has such a write
 *     or call does not qualify, nor does a function with a label.
 *
 * Value-preserving by the last two points: each read of M gives the value x would have
 * given. When in doubt, nothing changes.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, DeclStmt, Expression, ExprStmt, FunctionDecl,
  Identifier, IfStmt, MemberExpr, ParameterDecl, ParenExpr, Statement, TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST, getChildren } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape, type ExprShape } from './expr-shape.js';
import { shapeOfNode, sameShape, type TypedefResolver } from './call-arg-cast.js';

export interface RangeReadInlineOptions extends PluginOptions {
  enumTypes?: string[];
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  fieldTypes?: Record<string, string>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  onSite?: (e: { variable: string; read: string; uses: number }) => void;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function isIdent(e: Expression, name: string): boolean {
  const u = unwrap(e);
  return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
}

function isIntConstant(e: Expression): boolean {
  let u = unwrap(e);
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-') u = unwrap((u as UnaryExpr).operand);
  return u.kind === NodeKind.IntegerLiteral || u.kind === NodeKind.CharLiteral;
}

const LOWER = new Set(['>=', '>']);
const UPPER = new Set(['<=', '<']);
const MIRROR: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=' };

/** `x OP k` (or `k OP x`, mirrored): the operator as read with x on the left, or null. */
function boundOf(e: Expression, x: string): string | null {
  const u = unwrap(e);
  if (u.kind !== NodeKind.BinaryExpr) return null;
  const b = u as BinaryExpr;
  if (!(b.operator in MIRROR)) return null;
  if (isIdent(b.left, x) && isIntConstant(b.right)) return b.operator;
  if (isIdent(b.right, x) && isIntConstant(b.left)) return MIRROR[b.operator];
  return null;
}

/** The conjuncts of a top-level `&&` chain. */
function conjuncts(e: Expression): Expression[] {
  const u = unwrap(e);
  if (u.kind === NodeKind.BinaryExpr && (u as BinaryExpr).operator === '&&') {
    return [...conjuncts((u as BinaryExpr).left), ...conjuncts((u as BinaryExpr).right)];
  }
  return [u];
}

/**
 * An `if` condition holding a two-sided test of x against constants: `x >= lo && x <= hi`
 * (two adjacent conjuncts of a chain), or the inverted `x < lo || x > hi` anywhere in it.
 */
function hasRangeTest(cond: Expression, x: string): boolean {
  const pair = (l: Expression, r: Expression) => {
    const a = boundOf(l, x), b = boundOf(r, x);
    return !!a && !!b && ((LOWER.has(a) && UPPER.has(b)) || (UPPER.has(a) && LOWER.has(b)));
  };
  const cs = conjuncts(cond);
  for (let i = 0; i + 1 < cs.length; i++) if (pair(cs[i], cs[i + 1])) return true;
  for (const n of traverseAST(cond)) {
    if (n.kind === NodeKind.BinaryExpr && (n as BinaryExpr).operator === '||' && pair((n as BinaryExpr).left, (n as BinaryExpr).right)) return true;
  }
  return false;
}

/** The name a memory read is rooted at, when it reads through names only. */
function readRoot(e: Expression): string | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.MemberExpr) {
    const m = u as MemberExpr;
    const o = unwrap(m.object);
    if (o.kind === NodeKind.Identifier) return (o as Identifier).name;
    return o.kind === NodeKind.MemberExpr ? readRoot(o) : null;
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') {
    const o = unwrap((u as UnaryExpr).operand);
    return o.kind === NodeKind.Identifier ? (o as Identifier).name : null;
  }
  return null;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt, NodeKind.SwitchStmt]);

/**
 * Whether every read of x after the assignment comes before any call, memory store or write
 * of `root`, in evaluation order. `state.dirty` is set by the first such event.
 */
class Walker {
  ok = true;
  uses = 0;
  constructor(private x: string, private root: string) {}

  private use(): void {
    this.uses++;
  }

  expr(e: ASTNode, st: { dirty: boolean }): void {
    if (!this.ok) return;
    switch (e.kind) {
      case NodeKind.Identifier:
        if ((e as Identifier).name === this.x) { if (st.dirty) this.ok = false; else this.use(); }
        return;
      case NodeKind.CallExpr: {
        const c = e as CallExpr;
        this.expr(c.callee, st);
        for (const a of c.arguments) this.expr(a, st);
        st.dirty = true;
        return;
      }
      case NodeKind.AssignExpr: {
        const a = e as AssignExpr;
        this.expr(a.right, st);
        const l = unwrap(a.left);
        if (l.kind === NodeKind.Identifier) {
          const n = (l as Identifier).name;
          if (n === this.x) { this.ok = false; return; }
          if (a.operator !== '=' ) this.expr(l, st);
          if (n === this.root) st.dirty = true;
        } else {
          for (const k of getChildren(l)) this.expr(k, st);
          st.dirty = true;
        }
        return;
      }
      case NodeKind.UnaryExpr:
      case NodeKind.PostfixExpr: {
        const op = (e as unknown as { operator: string }).operator;
        const operand = (e as unknown as { operand: Expression }).operand;
        if (op === '++' || op === '--') {
          const o = unwrap(operand);
          if (o.kind === NodeKind.Identifier) {
            if ((o as Identifier).name === this.x) { this.ok = false; return; }
            if ((o as Identifier).name === this.root) st.dirty = true;
          } else {
            this.expr(o, st);
            st.dirty = true;
          }
          return;
        }
        if (op === '&' && unwrap(operand).kind === NodeKind.Identifier && (unwrap(operand) as Identifier).name === this.x) {
          this.ok = false;
          return;
        }
        this.expr(operand, st);
        return;
      }
      case NodeKind.MemberExpr:
        this.expr((e as MemberExpr).object, st);
        return;
      default:
        for (const k of getChildren(e)) this.expr(k, st);
    }
  }

  stmt(s: ASTNode, st: { dirty: boolean }): void {
    if (!this.ok) return;
    if (s.kind === NodeKind.IfStmt) {
      const i = s as IfStmt;
      if (i.init) this.stmt(i.init as unknown as ASTNode, st);
      this.expr(i.condition, st);
      const a = { dirty: st.dirty }, b = { dirty: st.dirty };
      this.stmt(i.thenBranch, a);
      if (i.elseBranch) this.stmt(i.elseBranch, b);
      st.dirty = a.dirty || b.dirty;
      return;
    }
    if (LOOPS.has(s.kind)) {
      // A read inside a loop sees the loop's own later writes on the next pass.
      const probe = new Walker(this.x, this.root);
      const pst = { dirty: false };
      for (const k of getChildren(s)) probe.any(k, pst);
      const reads = [...traverseAST(s)].some(n => n.kind === NodeKind.Identifier && (n as Identifier).name === this.x);
      if (reads && (pst.dirty || st.dirty || !probe.ok)) { this.ok = false; return; }
      for (const k of getChildren(s)) this.any(k, st);
      return;
    }
    if (s.kind === NodeKind.ExprStmt) { this.expr((s as ExprStmt).expression, st); return; }
    if (s.kind === NodeKind.CompoundStmt) { for (const k of (s as CompoundStmt).statements) this.stmt(k, st); return; }
    for (const k of getChildren(s)) this.any(k, st);
  }

  any(n: ASTNode, st: { dirty: boolean }): void {
    if (String(n.kind).endsWith('Stmt')) this.stmt(n, st);
    else this.expr(n, st);
  }
}

/** The identifiers named x in n that are not a member's name. */
function namedReads(n: ASTNode, x: string): number {
  const members = new Set<ASTNode>();
  const all = [...traverseAST(n)];
  for (const m of all) if (m.kind === NodeKind.MemberExpr) members.add((m as MemberExpr).member);
  return all.filter(m => m.kind === NodeKind.Identifier && (m as Identifier).name === x && !members.has(m)).length;
}

interface Candidate {
  block: CompoundStmt; at: number; x: string; read: Expression;
  /** The block and index of x's declaration: the assignment's own, or one without a value. */
  declBlock: CompoundStmt; decl: number;
}

function createRangeReadInlineTransformer(options: RangeReadInlineOptions = {}): Transformer {
  const enumTypes = new Set(options.enumTypes ?? []);
  const typedefTargets = options.typedefTargets ?? {};
  const resolve: TypedefResolver = name => (enumTypes.has(name) ? undefined : typedefTargets[name]);
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const all = [...traverseAST(fn.body)];
      if (all.some(n => n.kind === NodeKind.LabelStmt || n.kind === NodeKind.GotoStmt)) return undefined;
      const localTypes = new Map<string, TypeNode>();
      const declCount = new Map<string, number>();
      for (const p of fn.parameters as ParameterDecl[]) {
        if (!p.name) continue;
        localTypes.set(p.name.name, p.type);
        declCount.set(p.name.name, 2);
      }
      for (const n of all) {
        if (n.kind !== NodeKind.VariableDecl) continue;
        const v = n as VariableDecl;
        declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
        if (v.specifiers.includes('static') || v.specifiers.includes('extern')) declCount.set(v.name.name, 2);
      }
      // Every name tested by a two-sided constant range test of an `if`.
      const tested = new Set<string>();
      for (const n of all) {
        if (n.kind !== NodeKind.IfStmt) continue;
        for (const name of declCount.keys()) if (declCount.get(name) === 1 && hasRangeTest((n as IfStmt).condition, name)) tested.add(name);
      }
      if (tested.size === 0) return undefined;
      const shapeOf: ExprShape = createExprShape(localTypes, {
        globalTypes: options.globalTypes ?? {},
        enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {},
        fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {},
        resolve,
      });

      const body = cloneNode(fn.body) as CompoundStmt;
      const cands: Candidate[] = [];
      const writes = (x: string) => [...traverseAST(body)].filter(n =>
        (n.kind === NodeKind.AssignExpr && isIdent((n as AssignExpr).left, x))
        || ((n.kind === NodeKind.UnaryExpr || n.kind === NodeKind.PostfixExpr)
          && ['++', '--', '&'].includes((n as unknown as { operator: string }).operator)
          && isIdent((n as unknown as { operand: Expression }).operand, x))).length;
      // Every declaration without a value: where it is.
      const bare = new Map<string, { block: CompoundStmt; idx: number }>();
      const blocks = [...traverseAST(body)].filter(n => n.kind === NodeKind.CompoundStmt) as CompoundStmt[];
      for (const b of blocks) {
        b.statements.forEach((d, j) => {
          if (d.kind !== NodeKind.DeclStmt || (d as DeclStmt).declarations.length !== 1) return;
          const v = (d as DeclStmt).declarations[0];
          if (v.kind === NodeKind.VariableDecl && !(v as VariableDecl).initializer) bare.set((v as VariableDecl).name.name, { block: b, idx: j });
        });
      }
      const visit = (n: ASTNode): void => {
        for (const k of getChildren(n)) visit(k);
        if (n.kind !== NodeKind.CompoundStmt) return;
        const list = (n as CompoundStmt).statements;
        list.forEach((s, i) => {
          let x: string | null = null, read: Expression | null = null, decl = -1;
          let declBlock = n as CompoundStmt;
          if (s.kind === NodeKind.DeclStmt) {
            const ds = (s as DeclStmt).declarations;
            if (ds.length === 1 && ds[0].kind === NodeKind.VariableDecl) {
              const v = ds[0] as VariableDecl;
              if (v.initializer && v.initializer.kind !== NodeKind.InitListExpr && !v.directInit) {
                x = v.name.name; read = v.initializer as Expression; decl = i;
              }
            }
          } else if (s.kind === NodeKind.ExprStmt) {
            const e = unwrap((s as ExprStmt).expression);
            if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' && unwrap((e as AssignExpr).left).kind === NodeKind.Identifier) {
              x = (unwrap((e as AssignExpr).left) as Identifier).name;
              read = (e as AssignExpr).right;
              // Its declaration, without a value: earlier in this block, or in an enclosing one
              // when x is read nowhere but after the assignment here (checked below).
              const d = x ? bare.get(x) : undefined;
              if (!d || (d.block === n && d.idx >= i) || writes(x!) !== 1) x = null;
              else { declBlock = d.block; decl = d.idx; }
            }
          }
          if (!x || !read || !tested.has(x)) return;
          if (s.kind === NodeKind.DeclStmt && writes(x) !== 0) return;
          const root = readRoot(read);
          if (!root || root === x) return;
          const xs = shapeOfNode(localTypes.get(x)!, 0, resolve), rs = shapeOf(read);
          if (!xs || !rs || xs.stars !== 0 || !sameShape(xs, rs)) return;
          cands.push({ block: n as CompoundStmt, at: i, decl, declBlock, x, read });
        });
      };
      visit(body);
      if (cands.length === 0) return undefined;

      let changed = false;
      // One per block: a rewrite moves the statements the others are indexed by.
      const done = new Set<CompoundStmt>();
      for (const c of cands) {
        if (done.has(c.block) || done.has(c.declBlock)) continue;
        const list = c.block.statements;

        // No read of x before the assignment, in the block or anywhere outside it.

        const w = new Walker(c.x, readRoot(c.read)!);
        const st = { dirty: false };
        for (const s of list.slice(c.at + 1)) w.stmt(s, st);
        if (!w.ok || w.uses === 0) continue;
        const named = list.slice(c.at + 1).reduce((k, s) => k + namedReads(s, c.x), 0);
        // Every read of x in the function is one of these (the declaration's name and the
        // assignment's target are no reads).
        const own = c.declBlock === c.block && c.decl === c.at ? 1 : 2;
        if (named !== w.uses || namedReads(body, c.x) - own !== w.uses) continue;
        const replace = createTransformer({
          visitIdentifier(id: Identifier): ASTNode | undefined {
            return id.name === c.x ? { ...cloneNode(c.read), location: id.location } as ASTNode : undefined;
          },
          // A member named like x is no read of x: put its name back.
          visitMemberExpr(m: MemberExpr): ASTNode | undefined {
            const k = m.member.kind;
            if (k === NodeKind.Identifier || k === NodeKind.QualifiedId || k === NodeKind.TemplateType) return undefined;
            return updateNode(m, { member: { kind: NodeKind.Identifier, name: c.x, location: m.location, leadingTrivia: [], trailingTrivia: [] } as unknown as Identifier } as Partial<MemberExpr>);
          },
        });
        const rest = list.slice(c.at + 1).map(s => replace(s) as Statement);
        const head = list.slice(0, c.at).filter((_, j) => c.declBlock !== c.block || j !== c.decl);
        c.block.statements.splice(0, list.length, ...head, ...rest);
        if (c.declBlock !== c.block) c.declBlock.statements.splice(c.decl, 1);
        done.add(c.block);
        done.add(c.declBlock);
        changed = true;
        options.onSite?.({ variable: c.x, read: emit(c.read as AnyNode), uses: w.uses });
      }
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const rangeReadInlinePlugin: TransformPlugin = {
  id: 'range-read-inline',
  name: 'Range Read Inline',
  description: 'A local holding a memory read that a two-compare constant range test reads is the read itself',
  version: '1.0.0',
  defaultEnabled: true,
  // Before range-test-form (989.8), which writes the original's folded differences as two
  // compares of a local that the original did hold.
  priority: 989.75,
  tags: ['matching'],
  createTransformer: (options: RangeReadInlineOptions = {}) => createRangeReadInlineTransformer(options),
};

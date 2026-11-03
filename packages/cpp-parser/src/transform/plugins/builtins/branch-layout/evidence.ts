/**
 * Where an `if`'s arms lie in the original binary, read from the decompiler's markup.
 *
 * The extraction (reconstruct extract/branch-layout.ts) records, per line of the decompile,
 * the code offsets its tokens print, and per `if` keyword the offset of its conditional
 * branch. The caller hands both over keyed by the line of the PARSED text. Statements keep
 * their parse location through every pass (a moved or rebuilt statement copies it), so the
 * evidence travels with the code: an arm's entry is the lowest offset printed on the lines
 * of the statements it holds now, above the if's branch (a load the compiler hoisted above
 * the branch prints on an arm's line, but is not where the arm starts).
 *
 * A line that two statements claim (a pass copied one: a duplicated return, a halt tail
 * copied to each jump site) gives no evidence: which copy sits at that address is unknown.
 * Nor does an offset that the lines of two statements print: two identical tails the
 * compiler cross-jumped (`return 0;` written twice, one copy of the code) both print the
 * survivor's address, which is where neither statement was written. Asked about a run of
 * statements, an offset printed only by statements of that run still counts: a tail call
 * prints its one `jmp` on the call and on the `return` of its value. A statement a pass
 * built from nothing has no source line and gives no evidence either. A statement owns as
 * well the lines a pass folded into it (`foldedLines`): a dropped store whose constant the
 * statement now takes still printed the arm's code.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type { ASTNode, AnyNode, IfStmt, Statement, Expression, SwitchStmt, ReturnStmt, BinaryExpr } from '../../../../ast/nodes.js';
import { emit } from '../../../../emit/index.js';
import { getChildren, traverseAST } from '../../../../ast/visitor.js';

export interface BranchLayoutEvidence {
  /** Parsed-text line -> code offsets (from the function entry) its tokens print, ascending. */
  lines: ReadonlyMap<number, readonly number[]>;
  /** Parsed-text line of an `if` keyword -> the offset of its conditional branch. */
  ifs: ReadonlyMap<number, number>;
  /** Parsed-text line -> its `==`/`!=` tokens in text order, with the instruction behind each. */
  tests?: ReadonlyMap<number, readonly EqualityTest[]>;
  /**
   * Parsed-text line of an `if` whose condition is a short-circuit chain -> per leaf operand
   * of its `&&`/`||` operators at any depth, in text order, the offsets of the conditional
   * branches it feeds.
   */
  operands?: ReadonlyMap<number, readonly (readonly number[])[]>;
  /** Every RET of the function with the instructions that reach it only by falling through. */
  returns?: readonly ReturnCopy[];
  /**
   * Every conditional jump an `if`/`while` keyword prints, keyed by parsed-text line and
   * the keyword's index among the branching keywords of its line, with the lines each of
   * its two edges leads to.
   */
  edges?: readonly BranchEdge[];
  /** Every PUSH of an immediate, with the straight run of code it sits in (extract/branch-layout.ts). */
  pushes?: readonly PushImmediate[];
}

/**
 * A PUSH of an immediate. `reach`: where its straight run (no call, branch or jump target
 * inside) goes on, by a jump (`jumps`) or by falling into a jump target; `run`: the PUSHes
 * in that run.
 */
export interface PushImmediate {
  at: number;
  value: number;
  reach?: number;
  jumps?: boolean;
  run?: number;
}

/** A keyword's conditional jump: where it goes, where it falls, and the lines each leads to. */
export interface BranchEdge {
  line: number;
  ord: number;
  keyword: 'if' | 'while';
  jcc: number;
  target: number;
  fall: number;
  fallLines: readonly number[];
  takenLines: readonly number[];
}

/** A return copy of the original: its first instruction, its RET, and their mnemonics. */
export interface ReturnCopy {
  start: number;
  ret: number;
  /** Mnemonic per instruction, with `/REG` when the first operand is a register. */
  insns: readonly string[];
  /** Offsets of the jumps that land on `start`; absent in older facts. */
  jumpsIn?: readonly number[];
  /** Whether the instruction before `start` falls into it; absent in older facts. */
  fallsIn?: boolean;
}

/** An equality token of the decompile and the instruction its p-code op sits on. */
export interface EqualityTest {
  op: '==' | '!=';
  mnemonic: string;
  /** First operand when a register, else `-`. */
  reg: string;
  /** What a SUB/ADD/DEC/INC takes off the register (ADD/INC negated). */
  delta?: number;
  /** The constant compared against, unsigned, `size` bytes. */
  k?: number;
  size: number;
  /** The instruction's offset from the function entry. */
  at: number;
}

const LOOPS = new Set<string>([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ForRangeStmt]);

export function isLoop(n: ASTNode): boolean {
  return LOOPS.has(n.kind);
}

/** The leaf operands of a short-circuit condition: one per `&&`/`||` plus one, a null-guarded getter counting as two. */
function leafOperands(e: Expression): number {
  let n = 1;
  for (const x of traverseAST(e)) {
    if (x.kind === NodeKind.BinaryExpr && ((x as BinaryExpr).operator === '&&' || (x as BinaryExpr).operator === '||')) n++;
    else if (x.kind === NodeKind.ConditionalExpr && x.ghidraInfo?.nullGetter) n++;
  }
  return n;
}

function isStatement(n: ASTNode): boolean {
  return String(n.kind).endsWith('Stmt');
}

/** `n` and every statement below it. */
function* traverseStatements(n: ASTNode): Generator<ASTNode> {
  yield n;
  for (const k of getChildren(n)) if (isStatement(k)) yield* traverseStatements(k);
}

/** A node the parser placed: a pass that builds a node from nothing gives it no file. */
function placed(n: ASTNode): boolean {
  return !!n.location && n.location.file !== '<generated>' && n.location.start.line > 0;
}

/**
 * The lines a statement owns: a statement holding no statements owns its whole range; one
 * holding statements owns the ranges of its own expressions (a condition, a for header) and
 * passes the rest down.
 */
function ownedRanges(s: ASTNode, out: (from: number, to: number, visit: number) => void, seq = { n: 0 }): void {
  const visit = seq.n++;
  for (const l of s.ghidraInfo?.foldedLines ?? []) out(l, l, visit);
  const kids = getChildren(s);
  if (!kids.some(isStatement)) {
    if (placed(s)) out(s.location.start.line, s.location.end.line, visit);
    return;
  }
  // A label or case label prints no code of its own: its line is the statement's it labels.
  const labelLike = s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt;
  for (const k of kids) {
    if (isStatement(k)) ownedRanges(k, out, seq);
    else if (!labelLike && placed(k)) out(k.location.start.line, k.location.end.line, visit);
  }
}

export class LayoutReader {
  private readonly tainted = new Set<number>();
  private readonly shared = new Set<number>();
  /** Offset -> the untainted lines that print it. */
  private readonly printers = new Map<number, Set<number>>();
  private readonly ifLines = new Map<number, number>();
  /**
   * Line -> the text of the first if's condition on it, in pre-order: the leftmost piece of
   * a split condition. By text: the transformer rebuilds the nodes it walks.
   */
  private readonly firstIf = new Map<number, string>();
  private readonly switchLines = new Map<number, number>();
  /** Line -> the placed ifs that start on it, in pre-order. */
  private readonly ifsAt = new Map<number, IfStmt[]>();
  /** Line -> how many statement ranges claim it. */
  private readonly claims = new Map<number, number>();

  /** `root`: the function body as it is now, after the passes that ran before. */
  constructor(private readonly ev: BranchLayoutEvidence, root: ASTNode) {
    // Each visit of a statement is one owner: the same node object reached twice (a pass
    // that shared it between two sites) claims its lines twice.
    const owners = new Map<number, number>();
    ownedRanges(root, (from, to, visit) => {
      for (let l = from; l <= to; l++) {
        this.claims.set(l, (this.claims.get(l) ?? 0) + 1);
        const o = owners.get(l);
        if (o !== undefined && o !== visit) this.tainted.add(l);
        else owners.set(l, visit);
      }
    });
    const printedBy = new Map<number, number>();
    for (const [l, owner] of owners) {
      if (this.tainted.has(l)) continue;
      for (const off of ev.lines.get(l) ?? []) {
        const o = printedBy.get(off);
        if (o !== undefined && o !== owner) this.shared.add(off);
        else printedBy.set(off, owner);
        let p = this.printers.get(off);
        if (!p) this.printers.set(off, p = new Set());
        p.add(l);
      }
    }
    const visit = (n: ASTNode): void => {
      if (n.kind === NodeKind.IfStmt && placed(n)) {
        const l = n.location.start.line;
        this.ifLines.set(l, (this.ifLines.get(l) ?? 0) + 1);
        const at = this.ifsAt.get(l);
        if (at) at.push(n as IfStmt); else this.ifsAt.set(l, [n as IfStmt]);
        if (!this.firstIf.has(l)) this.firstIf.set(l, emit((n as IfStmt).condition as AnyNode));
      }
      if (n.kind === NodeKind.SwitchStmt && placed(n)) {
        const l = n.location.start.line;
        this.switchLines.set(l, (this.switchLines.get(l) ?? 0) + 1);
      }
      for (const k of getChildren(n)) if (isStatement(k)) visit(k);
    };
    visit(root);
  }

  /**
   * The conditional jump of an `if` keyword: the decompile's ifs of the if's line, in
   * column order, against the AST's placed ifs of that line in pre-order. Null when the
   * counts differ (a pass split or copied one) or the facts have no edges.
   */
  edge(ifs: IfStmt): BranchEdge | null {
    if (!this.ev.edges || !placed(ifs)) return null;
    const l = ifs.location.start.line;
    const facts = this.ev.edges.filter(e => e.line === l && e.keyword === 'if');
    const ours = this.ifsAt.get(l) ?? [];
    if (facts.length === 0 || facts.length !== ours.length) return null;
    const k = ours.indexOf(ifs);
    // The transformer rebuilds the nodes it walks: an if not found by identity is found by its column.
    const at = k >= 0 ? k : ours.findIndex(o => o.location.start.column === ifs.location.start.column);
    if (at < 0) return null;
    // The jump is the last test's: an if holding fewer of the decompile condition's operands
    // (a pass split `if (a && b)` into one if per test) is not the one that ends on it.
    if (this.ev.operands && ours.length === 1) {
      const segs = this.ev.operands.get(l);
      if ((segs ? segs.length : 1) !== leafOperands(ifs.condition)) return null;
    }
    return facts[at];
  }

  /**
   * Which of an if's successors its conditional jump falls into: `then` when the
   * fall-through block prints on the then-arm's lines and the jump's target does not,
   * `other` when the jump's target does and the fall-through does not, or the arm prints
   * no code at all; null when the facts cannot say (an arm whose lines a pass moved).
   */
  fallInto(ifs: IfStmt): 'then' | 'other' | null {
    const e = this.edge(ifs);
    if (!e) return null;
    const own = this.linesOf([ifs.thenBranch]);
    const fT = e.fallLines.some(l => own.has(l));
    const tT = e.takenLines.some(l => own.has(l));
    if (fT && !tT) return 'then';
    if (!fT && tT) return 'other';
    // An arm that prints no code (a bare jump or return) is never fallen into.
    if (!fT && e.fallLines.length > 0 && ![...own].some(l => (this.ev.lines.get(l) ?? []).length > 0)) return 'other';
    return null;
  }

  /** Every conditional jump of the function whose target is `offset`. */
  jumpsTo(offset: number): readonly BranchEdge[] {
    return (this.ev.edges ?? []).filter(e => e.target === offset);
  }

  /**
   * Code from `from` runs straight into `copy`: the copy is fallen into, lies at or after
   * `from`, and no other return copy ends in between.
   */
  runsInto(from: number, copy: ReturnCopy): boolean {
    if (copy.fallsIn !== true || from > copy.start) return false;
    return !(this.ev.returns ?? []).some(c => c !== copy && c.ret >= from && c.ret < copy.start);
  }

  /** Every return copy of the original; none without return facts. */
  copies(): readonly ReturnCopy[] {
    return this.ev.returns ?? [];
  }

  /** A return copy of the original starts at `offset`. */
  returnCopyAt(offset: number): boolean {
    return this.returnCopyStarting(offset) !== null;
  }

  /** The return copy of the original that starts at `offset`, or null. */
  returnCopyStarting(offset: number): ReturnCopy | null {
    return (this.ev.returns ?? []).find(c => c.start === offset) ?? null;
  }

  /** Every line `stmts` claim, copied or not. */
  linesOf(stmts: readonly ASTNode[]): Set<number> {
    const own = new Set<number>();
    for (const s of stmts) ownedRanges(s, (from, to) => { for (let l = from; l <= to; l++) own.add(l); });
    return own;
  }

  /** A line `s` owns is claimed by another statement too: a pass copied it. */
  copied(s: Statement): boolean {
    let hit = false;
    ownedRanges(s, (from, to) => { for (let l = from; l <= to; l++) if (this.tainted.has(l)) hit = true; });
    return hit;
  }

  /** Drop the evidence of the lines `stmts` own: a pass copied them. */
  taint(stmts: readonly Statement[]): void {
    for (const s of stmts) ownedRanges(s, (from, to) => { for (let l = from; l <= to; l++) this.tainted.add(l); });
  }

  /** The offset of the if's conditional branch; null when unknown or shared. */
  cbranch(ifs: IfStmt): number | null {
    if (!placed(ifs)) return null;
    const l = ifs.location.start.line;
    if (this.ifLines.get(l) !== 1 || this.tainted.has(l)) return null;
    return this.ev.ifs.get(l) ?? null;
  }

  /**
   * The branch of an if that a pass split off the decompile's one `if`: a short-circuit
   * condition with an assignment in it (`if (a && (x = e, x)) B`) becomes nested ifs on
   * the `if`'s line. The outermost of them takes that line's branch offset, which is the
   * last test's: the code of every arm it holds lies after it. Null unless every if on the
   * line, and every statement that claims the line (the assignments split out with them),
   * sits inside this one.
   */
  chainBranch(ifs: IfStmt): number | null {
    const own = this.cbranch(ifs);
    if (own !== null) return own;
    if (!placed(ifs)) return null;
    const l = ifs.location.start.line;
    const total = this.ifLines.get(l) ?? 0;
    if (total < 2) return null;
    let inside = 0;
    for (const n of traverseStatements(ifs)) {
      if (n.kind === NodeKind.IfStmt && placed(n) && n.location.start.line === l) inside++;
    }
    let claimed = 0;
    ownedRanges(ifs, (from, to) => { if (from <= l && l <= to) claimed++; });
    return inside === total && claimed === this.claims.get(l) ? this.ev.ifs.get(l) ?? null : null;
  }

  /**
   * The offset of a jump-table switch's indirect jump: the highest offset its line prints
   * (the `switch` keyword carries the BRANCHIND, its operand the loads before it). Null for
   * a switch a pass built from ifs (its line is an `if` line), a copied one, or an unknown line.
   */
  switchBranch(sw: SwitchStmt): number | null {
    if (!placed(sw)) return null;
    const l = sw.location.start.line;
    if (this.switchLines.get(l) !== 1 || this.ifLines.has(l) || this.ev.ifs.has(l) || this.tainted.has(l)) return null;
    const offs = this.ev.lines.get(l);
    return offs && offs.length > 0 ? offs[offs.length - 1] : null;
  }

  /**
   * The equality tokens printed on the lines from the `if` keyword to the end of its
   * condition, in text order; null when the facts have none or the if is not alone on its
   * line (a copied if, another if there). A one-line `if (c) stmt;` shares its line with its
   * arm, so the arm's tokens count too; the caller checks the number it expects.
   */
  conditionTests(ifs: IfStmt): readonly EqualityTest[] | null {
    const c: Expression = ifs.condition;
    if (!this.ev.tests || !placed(ifs) || !placed(c)) return null;
    const first = ifs.location.start.line;
    if (this.ifLines.get(first) !== 1) return null;
    const out: EqualityTest[] = [];
    for (let l = first; l <= c.location.end.line; l++) out.push(...(this.ev.tests.get(l) ?? []));
    return out;
  }

  /**
   * Per leaf operand of the if's `&&`/`||` chain, in text order, the offsets of the
   * conditional branches it feeds; null when the facts have none, the if is not alone on
   * its line, or its line was copied.
   */
  operandBranches(ifs: IfStmt, leaves?: number): readonly (readonly number[])[] | null {
    if (!this.ev.operands || !placed(ifs)) return null;
    const l = ifs.location.start.line;
    const all = this.ev.operands.get(l);
    if (!all) return null;
    if (this.ifLines.get(l) === 1) return this.tainted.has(l) ? null : all;
    // A pass split the decompile's one condition into several ifs on its line (comma-expand
    // at a `(x = e, x)` operand): the first of them, in pre-order, holds its leading operands.
    // The line is claimed by every piece, so it reads as copied; the operands are not.
    if (leaves === undefined || leaves >= all.length || this.firstIf.get(l) !== emit(ifs.condition as AnyNode)) return null;
    return all.slice(0, leaves);
  }

  /**
   * The conditional branch of the first if a pass split off a short-circuit condition:
   * the last branch its own leading operands feed. Null unless `operandBranches` gives
   * them, each with a branch.
   */
  prefixBranch(ifs: IfStmt, leaves: number): number | null {
    const own = this.operandBranches(ifs, leaves);
    if (!own || this.ifLines.get(ifs.location.start.line) === 1 || own.some(b => b.length === 0)) return null;
    return Math.max(...own.flat());
  }

  /**
   * Where the original's one copy of a `return` lies, for a return a pass copied or the
   * decompile printed more than once: the lowest offset its line prints, when that offset
   * and every other the line prints fall in one return copy of the facts (the run that
   * falls through into a RET). The passes copy a merged return to every path that reaches
   * it, so its line is claimed several times and `entry` gives no evidence; but the
   * original holds one copy, and this is where it is. Null without return facts, for a
   * line that prints nothing, or one whose offsets span more than one copy.
   */
  returnCopy(ret: ReturnStmt): number | null {
    if (!this.ev.returns || !placed(ret)) return null;
    const offs: number[] = [];
    for (let l = ret.location.start.line; l <= ret.location.end.line; l++) offs.push(...(this.ev.lines.get(l) ?? []));
    if (offs.length === 0) return null;
    const lo = Math.min(...offs), hi = Math.max(...offs);
    const copy = this.ev.returns.find(c => c.start <= lo && lo <= c.ret);
    return copy && hi <= copy.ret ? lo : null;
  }

  /**
   * Where the original keeps the one copy of a group of identical returns. `inline`: code
   * falls into it, code of the function lies after it, and a later test jumps back to it.
   * `end`: no code but other return copies lies after it, and every jump into it comes from
   * before. Null without return facts, when the members' lines place no copy or more than
   * one, or the two readings disagree (a block sunk below the copy, a copy inline at a later
   * guard).
   */
  mergedCopyPlace(rets: readonly ReturnStmt[]): 'inline' | 'end' | null {
    const returns = this.ev.returns;
    const copy = this.sharedCopy(rets);
    if (!returns || !copy || !copy.jumpsIn || copy.jumpsIn.length === 0) return null;
    const inCopy = (o: number) => returns.some(c => c.start <= o && o <= c.ret);
    let after = false;
    for (const offs of this.ev.lines.values()) {
      if (offs.some(o => o > copy.ret && !inCopy(o))) { after = true; break; }
    }
    const back = copy.jumpsIn.some(j => j > copy.start);
    if (!after && !back) return 'end';
    return after && back && copy.fallsIn === true ? 'inline' : null;
  }

  /**
   * The one return copy of the original that the lines of `rets` place them all in; null
   * when they place none, or two (VC8 keeps two copies whose epilogues differ: a return
   * before a register is saved restores fewer).
   */
  sharedCopy(rets: readonly ReturnStmt[]): ReturnCopy | null {
    const returns = this.ev.returns;
    if (!returns) return null;
    const at = new Set<ReturnCopy>();
    for (const r of rets) {
      const lo = this.returnCopy(r);
      if (lo !== null) at.add(returns.find(c => c.start <= lo && lo <= c.ret)!);
    }
    return at.size === 1 ? [...at][0] : null;
  }

  /** Lowest offset printed by the condition's lines; null when unknown. */
  conditionLow(ifs: IfStmt): number | null {
    const c: Expression = ifs.condition;
    if (!placed(ifs) || !placed(c)) return null;
    let low: number | null = null;
    for (let l = ifs.location.start.line; l <= c.location.end.line; l++) {
      if (this.tainted.has(l)) return null;
      for (const o of this.ev.lines.get(l) ?? []) if (low === null || o < low) low = o;
    }
    return low;
  }

  /**
   * The lowest offset above `after` on the lines `stmts` own now; null when none. An offset
   * other statements print as well counts only when all of them are among `stmts`.
   */
  entry(stmts: readonly Statement[], after: number): number | null {
    const own = new Set<number>();
    for (const s of stmts) {
      ownedRanges(s, (from, to) => {
        for (let l = from; l <= to; l++) if (!this.tainted.has(l)) own.add(l);
      });
    }
    let best: number | null = null;
    for (const l of own) {
      for (const o of this.ev.lines.get(l) ?? []) {
        if (o <= after || (best !== null && o >= best)) continue;
        if (this.shared.has(o) && ![...(this.printers.get(o) ?? [])].every(p => own.has(p))) continue;
        best = o;
      }
    }
    return best;
  }
}

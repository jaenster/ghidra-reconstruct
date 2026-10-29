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
 * built from nothing has no source line and gives no evidence either.
 */

import { NodeKind } from '../../../../ast/kinds.js';
import type { ASTNode, IfStmt, Statement, Expression } from '../../../../ast/nodes.js';
import { getChildren } from '../../../../ast/visitor.js';

export interface BranchLayoutEvidence {
  /** Parsed-text line -> code offsets (from the function entry) its tokens print, ascending. */
  lines: ReadonlyMap<number, readonly number[]>;
  /** Parsed-text line of an `if` keyword -> the offset of its conditional branch. */
  ifs: ReadonlyMap<number, number>;
  /** Parsed-text line -> its `==`/`!=` tokens in text order, with the instruction behind each. */
  tests?: ReadonlyMap<number, readonly EqualityTest[]>;
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
      }
      for (const k of getChildren(n)) if (isStatement(k)) visit(k);
    };
    visit(root);
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

/**
 * Names for the gotos that stay (design section 6, step 11).
 *
 * A kept goto gets the name a programmer plausibly gave its label, derived from evidence in
 * the function itself - never `LAB_xxxx`, never a counter that claims nothing. The names go
 * into Ghidra as labels at the block's address (by the single writer, from the proposals
 * TSV); the decompile then prints them, so the generator never invents a label name.
 *
 * In order, the first rule that applies:
 *
 *   library     the library source's own label (library-evidence.ts `sourceLabel`)
 *   user        a label someone already named: kept as it is
 *   structural  true by construction from where the label sits:
 *                 case_<v>       a case body entered from outside its case (a `case v:` that
 *                                only jumps here, or the label sits on `case v:`)
 *                 end_<x>_loop   the follow of the loop around the jumps (a break out of more
 *                                than one level); x is the loop's variable
 *                 next_<x>       the continue point of an enclosing loop, from a nested one
 *                 resume_<x>     a point inside a loop entered from outside it
 *   semantic    what the block does when it ends the function:
 *                 error          it releases something and returns a failure value
 *                 cleanup        it releases something and returns anything else
 *                 done           it only stores (out-params, fields) and returns
 *   descriptive what the block does first, in the corpus's lower-case: the call it makes
 *               (`play_sound` for `SOUND_PlaySound(...)`), the field it sets (`set_mode`),
 *               what it tests (`check_mode`) - for a shared block that is not an exit
 *
 * A second label with the same name in one function takes the literal that tells the two
 * apart (`set_mode_29`), else the next distinct word of its block; `2` only as a last resort.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';

type Any = any;

export interface LabelProposal {
  label: string;
  name: string;
  kind: 'library' | 'user' | 'structural' | 'semantic' | 'descriptive' | 'residual';
  evidence: string;
}

const KEYWORDS = new Set(['break', 'case', 'continue', 'default', 'do', 'else', 'for', 'goto', 'if', 'return', 'switch', 'while', 'int', 'char', 'void', 'new', 'delete', 'this', 'try', 'catch', 'throw', 'true', 'false', 'auto', 'register', 'static', 'const', 'volatile', 'union', 'struct', 'class', 'enum', 'unsigned', 'signed', 'long', 'short', 'float', 'double', 'sizeof', 'operator', 'template', 'typename', 'public', 'private', 'protected', 'virtual', 'inline', 'extern', 'friend', 'namespace', 'using', 'bool']);
const RELEASE = /(Free|Release|Close|Destroy|Delete|Unlock|Leave|Unload|Unregister|Cleanup|CleanUp|Shutdown|Disconnect|Dealloc|Unmap|Unreserve|CloseHandle)/;
const GHIDRA_LABEL = /^(LAB_|switchD_|caseD_|joined_r0x|code_r0x|override_jmp_)/;

export const isGhidraLabel = (n: string) => GHIDRA_LABEL.test(n);

function strip(e: Any): Any {
  while (e && (e.kind === NodeKind.ParenExpr || e.kind === NodeKind.CStyleCastExpr)) e = e.expression;
  return e;
}

function kids(n: Any): Any[] {
  const out: Any[] = [];
  for (const k of Object.keys(n)) {
    if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
    const v = n[k];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof x.kind === 'string') out.push(x); }
    else if (v && typeof v === 'object' && typeof v.kind === 'string') out.push(v);
  }
  return out;
}
function* all(n: Any): Generator<Any> {
  if (!n || typeof n !== 'object') return;
  yield n;
  for (const c of kids(n)) yield* all(c);
}

/** lower_snake from PascalCase / camelCase, Hungarian prefix and module tag removed. */
export function snake(raw: string, dropHungarian = false): string {
  let s = raw.replace(/^.*::/, '');
  // MODULE_ tags (NET_D2GS_ConnectToServer -> ConnectToServer); a lone word left keeps the
  // last tag as its verb (DRAW_text -> draw_text).
  const tags = /^((?:[A-Z0-9]{2,}_)+)(?=[A-Za-z])/.exec(s);
  if (tags) {
    s = s.slice(tags[1].length);
    if (!/[a-z][A-Z]/.test(s) && !/_/.test(s)) s = tags[1].split('_').filter(Boolean).pop()!.toLowerCase() + '_' + s;
  }
  if (dropHungarian) s = s.replace(/^g_/, 'g').replace(/^(pp|p|n|dw|w|by|b|e|sz|wsz|f|pfn|a|g[a-z]{0,3}|i|u|s|h|lp|psz|pw|pb|pn|c|ch)(?=[A-Z])/, '');
  s = s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').toLowerCase();
  s = s.replace(/[^a-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  const words = s.split('_').filter(Boolean).slice(0, 5);
  return words.join('_');
}

function calleeName(e: Any): string | null {
  e = strip(e);
  if (!e) return null;
  if (e.kind === NodeKind.AssignExpr) return calleeName(e.right);
  if (e.kind !== NodeKind.CallExpr) return null;
  let c = strip(e.callee);
  if (c.kind === NodeKind.QualifiedId) c = c.name;
  if (c.kind === NodeKind.Identifier) return c.name;
  if (c.kind === NodeKind.MemberExpr) return c.member?.name ?? null;
  // (*pfn)(..): the pointer's name
  if (c.kind === NodeKind.UnaryExpr && c.operator === '*') { const o = strip(c.operand); if (o.kind === NodeKind.Identifier) return o.name; }
  return null;
}

/** The innermost name an lvalue writes: `p->mode` -> mode, `aBuf[i]` -> aBuf, `*pOut` -> pOut. */
function lvalueName(e: Any): string | null {
  e = strip(e);
  if (!e) return null;
  if (e.kind === NodeKind.Identifier) return e.name;
  if (e.kind === NodeKind.MemberExpr) return e.member?.name ?? null;
  if (e.kind === NodeKind.SubscriptExpr) return lvalueName(e.array);
  if (e.kind === NodeKind.UnaryExpr) return lvalueName(e.operand);
  for (const c of kids(e)) { const n = lvalueName(c); if (n) return n; }
  return null;
}

/** A decompiler default name: no evidence of what the value is. */
const DEFAULT_NAME = /^(param_\d+|local_\w+|[A-Za-z]{1,3}Var\d+|[A-Za-z]{1,3}Stack\w*|extraout_\w+|in_\w+|unaff_\w+|DAT_\w+|PTR_\w+|temp_\w+|register0x\w+)$/;
// `nAlignment_00` is Ghidra's second variable for nAlignment: the name is still evidence.
const named = (n: string | null) => { if (!n) return null; const m = n.replace(/_0\d*$/, ''); return DEFAULT_NAME.test(m) ? null : m; };

function firstLiteral(n: Any): string | null {
  for (const x of all(n)) {
    if (x.kind === NodeKind.IntegerLiteral) {
      const v = BigInt(x.value);
      return v < 0n ? `m${-v}` : String(v);
    }
  }
  return null;
}

/** Flatten a tail: its statements in order, through compounds and labels. */
function flatTail(stmts: Any[]): Any[] {
  const out: Any[] = [];
  for (let s of stmts) {
    while (s && (s.kind === NodeKind.LabelStmt || s.kind === NodeKind.CaseStmt || s.kind === NodeKind.DefaultStmt)) s = s.statement;
    if (!s || s.kind === NodeKind.NullStmt) continue;
    if (s.kind === NodeKind.CompoundStmt) out.push(...flatTail(s.statements));
    else out.push(s);
  }
  return out;
}

function isFailureValue(e: Any): boolean {
  e = strip(e);
  if (!e) return false;
  if (e.kind === NodeKind.IntegerLiteral) return BigInt(e.value) === 0n;
  if (e.kind === NodeKind.UnaryExpr && e.operator === '-') return true;
  if (e.kind === NodeKind.NullptrLiteral || e.kind === NodeKind.BoolLiteral) return e.kind === NodeKind.NullptrLiteral || e.value === false;
  if (e.kind === NodeKind.Identifier) return /^(FALSE|NULL)$/.test(e.name);
  return false;
}

/** The first name in evaluation order that is evidence (a field, a named variable). */
function firstNamed(e: Any): string | null {
  for (const x of all(e)) {
    if (x.kind === NodeKind.MemberExpr && named(x.member?.name ?? null)) return named(x.member.name);
    if (x.kind === NodeKind.Identifier && named(x.name)) return named(x.name);
  }
  return null;
}

/** A call's name as a label: a CRT routine (all lower case) takes what it works on. */
function callLabel(call: string, e: Any): string {
  const nm = snake(call, /^p[A-Z]|^pfn/.test(call));
  if (/^[a-z_0-9]+$/.test(call)) {
    const args = (strip(e).kind === NodeKind.AssignExpr ? strip(strip(e).right) : strip(e)).arguments ?? [];
    const on = args.length ? firstNamed(args[0]) : null;
    if (on) return `${nm}_${snake(on, true)}`;
  }
  return /^p[A-Z]|^pfn/.test(call) ? `call_${nm}` : nm;
}

/** Describe what a block does first, as a label name, with the evidence. */
function describe(stmts: Any[]): { name: string; why: string } | null {
  for (const s of flatTail(stmts)) {
    if (s.kind === NodeKind.ExprStmt) {
      const e = strip(s.expression);
      const call = calleeName(e);
      if (call) {
        const nm = callLabel(call, e);
        if (nm) return { name: nm, why: `calls ${call}` };
      }
      if (e.kind === NodeKind.AssignExpr) {
        const lv = named(lvalueName(e.left));
        if (lv) return { name: `set_${snake(lv, true)}`, why: `sets ${lv}` };
        // a temporary: what it is loaded from
        const from = firstNamed(e.right);
        if (from) return { name: `get_${snake(from, true)}`, why: `loads ${from}` };
      }
      if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) {
        const lv = named(lvalueName(e.operand));
        if (lv) return { name: `step_${snake(lv, true)}`, why: `steps ${lv}` };
      }
      continue; // a temporary with no evidence: what follows says what the block does
    }
    if (s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.DoWhileStmt || s.kind === NodeKind.SwitchStmt) {
      const cond = s.condition;
      const call = cond ? [...all(cond)].map(x => x.kind === NodeKind.CallExpr ? calleeName(x) : null).find(Boolean) : null;
      if (call) return { name: `check_${snake(call)}`, why: `tests ${call}(..)` };
      const lv = cond ? firstNamed(cond) : null;
      const verb = s.kind === NodeKind.SwitchStmt ? 'dispatch' : s.kind === NodeKind.IfStmt ? 'check' : 'scan';
      if (lv) return { name: `${verb}_${snake(lv, true)}`, why: `${s.kind === NodeKind.IfStmt ? 'tests' : s.kind === NodeKind.SwitchStmt ? 'switches on' : 'loops on'} ${lv}` };
      // a loop whose test names nothing: what its body does first
      if (s.kind !== NodeKind.IfStmt && s.kind !== NodeKind.SwitchStmt) {
        const inner = describe([s.body]);
        if (inner) return { name: inner.name.startsWith('scan_') ? inner.name : `scan_${inner.name.replace(/^(check|set|get)_/, '')}`, why: `loops; its body ${inner.why}` };
      }
      return null;
    }
    if (s.kind === NodeKind.ForStmt) {
      const lv = (s.init ? firstNamed(s.init) : null) ?? (s.condition ? firstNamed(s.condition) : null);
      if (lv) return { name: `scan_${snake(lv, true)}`, why: `loops over ${lv}` };
      return null;
    }
    if (s.kind === NodeKind.ReturnStmt) return { name: 'done', why: 'returns' };
    if (s.kind === NodeKind.DeclStmt) continue;
    return null;
  }
  return null;
}

export interface LabelContext {
  label: string;
  /** The statements from the label to the end of its list or the next case. */
  tail: Any[];
  /** Whether falling off the tail continues (false: it returns, breaks, halts). */
  tailFalls: boolean;
  /** The case values of `case v:` labels on the label's statement, or of cases that only jump here. */
  caseValues: string[];
  /** Structural position, when one applies. */
  loopExitOf?: string | null;   // the loop variable whose loop's follow this is, from a nested loop
  loopNextOf?: string | null;   // ... whose continue point this is, from a nested loop
  resumeOf?: string | null;     // ... whose body this is inside, entered from outside
  librarySourceLabel?: string | null;
  noreturn?: ReadonlySet<string>;
}

export function proposeName(c: LabelContext): LabelProposal {
  const { label } = c;
  if (c.librarySourceLabel) return { label, name: c.librarySourceLabel, kind: 'library', evidence: `library source label ${c.librarySourceLabel}` };
  if (!isGhidraLabel(label)) return { label, name: label, kind: 'user', evidence: 'existing user label, kept' };
  if (c.caseValues.length) {
    const v = c.caseValues[0];
    // The value as an identifier: an enumerator's own name, a negative number as m<n>.
    const ident = v.replace(/^\(\w+\)\s*/, '').replace(/^.*::/, '').replace(/^-/, 'm').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+$/, '');
    const name = v === 'default' ? 'default_case' : `case_${ident}`;
    return { label, name, kind: 'structural', evidence: `the body of case ${c.caseValues.join(', ')}, entered from outside it` };
  }
  if (c.loopExitOf !== undefined) return { label, name: c.loopExitOf ? `end_${c.loopExitOf}_loop` : 'end_outer_loop', kind: 'structural', evidence: `follow of the ${c.loopExitOf ?? 'outer'} loop, jumped to from a nested loop` };
  if (c.loopNextOf !== undefined) return { label, name: c.loopNextOf ? `next_${c.loopNextOf}` : 'next_outer', kind: 'structural', evidence: `continue point of the ${c.loopNextOf ?? 'outer'} loop, jumped to from a nested loop` };
  if (c.resumeOf !== undefined) return { label, name: c.resumeOf ? `resume_${c.resumeOf}` : 'resume_loop', kind: 'structural', evidence: `inside the ${c.resumeOf ?? ''} loop body, entered from outside the loop` };

  const flat = flatTail(c.tail);
  const last = flat[flat.length - 1];
  if (!c.tailFalls && last) {
    const calls = flat.map(s => (s.kind === NodeKind.ExprStmt ? calleeName(s.expression) : null)).filter((x): x is string => !!x);
    const released = calls.filter(n => RELEASE.test(n));
    if (last.kind === NodeKind.ReturnStmt) {
      const v = last.value ?? null;
      if (released.length) {
        if (v && isFailureValue(v)) return { label, name: 'error', kind: 'semantic', evidence: `releases (${released.join(', ')}) and returns a failure value` };
        return { label, name: 'cleanup', kind: 'semantic', evidence: `releases (${released.join(', ')}) and returns` };
      }
      const onlyStores = flat.slice(0, -1).every(s => s.kind === NodeKind.ExprStmt && strip(s.expression).kind === NodeKind.AssignExpr && !calleeName(s.expression));
      if (onlyStores) return { label, name: 'done', kind: 'semantic', evidence: flat.length > 1 ? 'stores the results and returns' : 'returns' };
    }
  }
  const d = describe(c.tail);
  if (d && d.name && !KEYWORDS.has(d.name)) return { label, name: d.name, kind: 'descriptive', evidence: `the block ${d.why}` };
  return { label, name: label, kind: 'residual', evidence: 'nothing in the block names it' };
}

/** Make the names of one function unique: a literal, then the next word, then a number. */
/** The first named thing in the block that the name does not already say. */
function otherWord(tail: Any[], base: string): string | null {
  const have = new Set(base.split('_'));
  for (const st of flatTail(tail)) {
    for (const x of all(st)) {
      const n = x.kind === NodeKind.MemberExpr ? named(x.member?.name ?? null) : x.kind === NodeKind.Identifier ? named(x.name) : null;
      if (!n) continue;
      const w = snake(n, true);
      if (w && w.length > 1 && !w.split('_').every(t => have.has(t))) return w;
    }
  }
  return null;
}

export function uniquify(props: { p: LabelProposal; tail: Any[] }[]): void {
  const taken = new Set<string>(props.filter(x => x.p.kind === 'user' || x.p.kind === 'residual').map(x => x.p.name));
  for (const x of props) {
    if (x.p.kind === 'residual' || x.p.kind === 'user') continue;
    const base = x.p.name;
    let name = base;
    if (taken.has(name)) {
      const lit = firstLiteral({ kind: 'X', statements: x.tail });
      const word = otherWord(x.tail, base);
      if (lit && !taken.has(`${base}_${lit}`)) name = `${base}_${lit}`;
      else if (word && !taken.has(`${base}_${word}`)) name = `${base}_${word}`;
      else { let n = 2; while (taken.has(`${base}${n}`)) n++; name = `${base}${n}`; }
      x.p.evidence += `; '${base}' already names another label here`;
    }
    taken.add(name);
    x.p.name = name;
  }
}

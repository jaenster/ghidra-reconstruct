/**
 * Defect checks over the TRANSFORMED AST - the same tree the emitter turns into C++.
 *
 * These replace the regex passes in docs/tools/lint.py. That suite matched emitted source
 * text, which made it wrong in both directions: its declaration pattern required exactly
 * four spaces of indentation, it could not tell a store from a load, and it had to guess
 * which function a line belonged to. None of that is expressible here.
 *
 * A check receives one function's AST and returns findings. Keep each check's rationale
 * next to it, including what it deliberately does NOT report - an unexplained exclusion is
 * how a check quietly stops finding the thing it was written for.
 */

import { NodeKind } from '../../packages/cpp-parser/src/ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CallExpr, Identifier,
} from '../../packages/cpp-parser/src/ast/nodes.js';
import { findNodesByKind } from '../../packages/cpp-parser/src/ast/visitor.js';
import { localFacts, declName, calleeName } from './locals.js';

export interface Finding {
  check: string;
  addr: string;
  fn: string;
  detail: string;
}

export interface CheckCtx {
  addr: string;
  fnName: string;
}

export type Check = (fn: FunctionDecl, ctx: CheckCtx) => Finding[];

/** Ghidra's synthetic register names - a separate, separately-counted class. */
const SYNTHETIC = /^(extraout_|in_|unaff_|__return_storage_ptr__)/;

/**
 * A local that is READ but never written, never initialized and never address-taken.
 *
 * This is the decompiler dropping a value that exists in the machine code - a callee's
 * return that Ghidra typed `void`, a register it lost, or a constant it failed to render.
 * The whole game's monster AI was one of these: a bounds constant rendered as an undeclared
 * variable, so every monster fell back to AI table entry 0 and stood still. Nothing warned.
 *
 * Escaped locals are excluded because a callee writes through them - `&x`, but also a bare
 * ARRAY name, which decays to a pointer with no `&` anywhere in the syntax. Synthetic register names are excluded because they
 * are the register-contract class, which is enumerated on its own - counting them here
 * would double-count and swamp the real findings.
 */
export const unassignedLocalRead: Check = (fn, ctx) => {
  const f = localFacts(fn);
  const out: Finding[] = [];
  for (const name of f.decls.keys()) {
    if (f.params.has(name)) continue;
    if (SYNTHETIC.test(name)) continue;
    if (f.initialized.has(name) || f.writes.has(name) || f.escaped.has(name)) continue;
    if (!f.reads.has(name)) continue;   // never read either: that is a dead decl, not this
    out.push({
      check: 'unassigned-local-read', addr: ctx.addr, fn: ctx.fnName,
      detail: `${name}: read but never assigned`,
    });
  }
  return out;
};

/** Same shape, restricted to the synthetic register names, so the two never mix. */
export const registerContractRead: Check = (fn, ctx) => {
  const f = localFacts(fn);
  const out: Finding[] = [];
  for (const name of f.decls.keys()) {
    if (!SYNTHETIC.test(name)) continue;
    if (f.initialized.has(name) || f.writes.has(name) || f.escaped.has(name)) continue;
    if (!f.reads.has(name)) continue;
    out.push({
      check: 'register-contract-read', addr: ctx.addr, fn: ctx.fnName,
      detail: `${name}: synthetic register read but never assigned`,
    });
  }
  return out;
};

/**
 * A call through a function pointer that passes NO arguments.
 *
 * Ghidra renders an indirect call it has no signature for as `(*pfn)()`. The machine code
 * almost always pushed arguments; they are simply not in the decompile. Emitting the call
 * with an empty argument list compiles and then corrupts the stack or reads garbage.
 *
 * A genuinely niladic callback exists, so this is a candidate list, not an error list. What
 * makes a hit actionable is the call-site signature override in Ghidra, which fixes the
 * whole class at the source rather than in the emitted tree.
 */
export const arglessIndirectCall: Check = (fn, ctx) => {
  const out: Finding[] = [];
  for (const c of findNodesByKind((fn as any).body ?? fn, NodeKind.CallExpr) as CallExpr[]) {
    const args = (c as any).arguments ?? (c as any).args ?? [];
    if (args.length) continue;
    const callee = (c as any).callee;
    if (!callee) continue;
    // A direct call to a named function is fine; an indirect one goes through a deref or
    // a member/pointer expression rather than a bare Identifier.
    const indirect =
      callee.kind === NodeKind.UnaryExpr && (callee as any).operator === '*' ||
      callee.kind === NodeKind.MemberExpr ||
      callee.kind === NodeKind.ParenExpr;
    if (!indirect) continue;
    out.push({
      check: 'argless-indirect-call', addr: ctx.addr, fn: ctx.fnName,
      detail: 'indirect call with no arguments',
    });
  }
  return out;
};

/**
 * A descriptor array built as one struct local followed by loose scalars.
 *
 * The .txt table compilers build a field-descriptor array on the stack and hand its base to
 * CompileTxt, which walks it to a terminating `"end"` entry. Ghidra models the first entry
 * as a struct and the terminator's members as separate locals, and we carry that split
 * faithfully - but the C compiler is free to order separate locals however it likes, while
 * the walk requires them CONTIGUOUS. Nothing in the emitted C++ says they must be adjacent,
 * so this survives every compile and every type check.
 *
 * This is not a generator defect: Ghidra splits it the same way. It is reported so the
 * frame can be modelled as a real array in Ghidra, which is where the fix belongs.
 */
export const splitDescriptorArray: Check = (fn, ctx) => {
  const body = (fn as any).body ?? fn;
  const f = localFacts(fn);
  const out: Finding[] = [];

  // The tell: a local whose initializer is the sentinel string, sitting in a function that
  // hands another local's address to a table-compiling callee.
  let sentinel: string | null = null;
  for (const [name, d] of f.decls) {
    const init: any = (d as any).initializer;
    const val = init && init.kind === NodeKind.StringLiteral
      ? (init.value ?? init.text ?? init.raw)
      : null;
    if (typeof val === 'string' && val.replace(/"/g, '') === 'end') sentinel = name;
  }
  if (!sentinel) return out;

  for (const c of findNodesByKind(body, NodeKind.CallExpr) as CallExpr[]) {
    const nm = calleeName((c as any).callee);
    if (nm && /CompileTxt|CompileTable/i.test(nm)) {
      out.push({
        check: 'split-descriptor-array', addr: ctx.addr, fn: ctx.fnName,
        detail: `sentinel '${sentinel}' is a separate local, not an array element - `
              + `adjacency is required but not guaranteed`,
      });
      break;
    }
  }
  return out;
};


/**
 * A range check written as `(x - BASE) < COUNT` with no unsigned cast.
 *
 * The binary performs these unsigned: `ADD EAX,-BASE ; CMP EAX,COUNT-1 ; JA/JBE`, which admits
 * only the window BASE..BASE+COUNT-1. Ghidra's p-code records that correctly (INT_LESS /
 * INT_LESSEQUAL), but its C rendering omits the cast whenever the left operand is a signed enum,
 * a signed int, or a uint16_t/byte that PROMOTES to signed int. In C the subtraction then goes
 * NEGATIVE for every value below BASE, the comparison is true, and the window silently becomes
 * "everything below BASE" as well.
 *
 * This is invisible in review - the expression reads exactly like a correct range check. It shipped
 * seven live defects here, including every runeword resolving to the same name, the wrong ambient
 * light across acts 1-4, and any click above y=24 landing on the help close button.
 *
 * CANDIDATES, NOT ERRORS. The shape alone cannot distinguish a real flip from a harmless one: when
 * the left operand is genuinely unsigned (a DWORD tick delta, a uint32_t id) C's unsigned
 * arithmetic already preserves the meaning. Adjudicate a hit by reading the p-code - an unsigned
 * comparison op over an operand that can go negative in C is the defect. Roughly nine in ten of
 * these are harmless, so the list is a work queue, not a count of bugs.
 *
 * Deliberately NOT filtered by operand type: the emitted type is exactly what is wrong in the
 * dangerous cases, so trusting it would hide them.
 */
export const signedRangeCheck: Check = (fn, ctx) => {
  const out: Finding[] = [];
  const body = (fn as any).body ?? fn;
  for (const cmp of findNodesByKind(body, NodeKind.BinaryExpr) as any[]) {
    const op = cmp.operator;
    if (op !== '<' && op !== '<=') continue;

    const lhs = cmp.left, rhs = cmp.right;
    if (!lhs || !rhs) continue;
    // Right side must be a small literal count.
    if (!String(rhs.kind).includes('Literal')) continue;
    // Left side must be a subtraction.
    if (lhs.kind !== NodeKind.BinaryExpr || lhs.operator !== '-') continue;

    // An explicit unsigned cast anywhere on the left means the author already handled it.
    const casts = findNodesByKind(lhs, NodeKind.CStyleCastExpr) as any[];
    const hasUnsignedCast = casts.some(c => {
      const t = c.type ?? c.castType;
      const n = t && (t.name ?? t.typeName ?? '');
      return typeof n === 'string' && /^u|unsigned|uint/i.test(n);
    });
    if (hasUnsignedCast) continue;

    out.push({
      check: 'signed-range-check', addr: ctx.addr, fn: ctx.fnName,
      detail: 'range check `(x - BASE) < N` with no unsigned cast - verify against p-code',
    });
  }
  return out;
};

export const ALL_CHECKS: Array<{ id: string; run: Check; blurb: string }> = [
  { id: 'unassigned-local-read', run: unassignedLocalRead,
    blurb: 'local read but never assigned - the decompiler dropped a value' },
  { id: 'register-contract-read', run: registerContractRead,
    blurb: 'extraout_/in_/unaff_ read but never assigned - register-contract class' },
  { id: 'argless-indirect-call', run: arglessIndirectCall,
    blurb: 'call through a function pointer with no arguments - may have dropped real ones' },
  { id: 'split-descriptor-array', run: splitDescriptorArray,
    blurb: 'table descriptor sentinel is a loose local - adjacency not guaranteed' },
  { id: 'signed-range-check', run: signedRangeCheck,
    blurb: '(x - BASE) < N with no unsigned cast - candidates, adjudicate via p-code' },
];

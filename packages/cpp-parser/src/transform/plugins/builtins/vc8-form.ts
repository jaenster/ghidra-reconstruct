/**
 * VC8 source forms recorded per function.
 *
 * Some choices of source form are evenly split across the original: as often a temporary
 * folded into its use as a temporary of its own, a field read again as a field cached in
 * a local, a guard returning early as one nested condition. No rule can pick the side, so
 * the side each function took is recorded in Ghidra, as a `vc8form` function tag, once a
 * VC8 compile of that form has matched the original's bytes. This pass writes the form the
 * tag names. Every form is addressed by names and expressions as the generator prints
 * them, never by line, and is applied after every other pass and the renames, to the body
 * as it is emitted. Every form refuses when its shape is not there: a tag that no
 * longer fits the body changes nothing.
 *
 * The forms (each argument is printed text; whitespace is ignored when comparing):
 *
 *   seq(L1,...,Ln)       the run of statements that store to (or declare and initialize)
 *                        L1..Ln, adjacent in one block and not in this order yet, is
 *                        written in the listed order. Refused when no run or more than
 *                        one fits; `seq(L1,...,Ln,@k)` takes the k-th of several. A
 *                        compound store and ++/-- store to their operand.
 *                        Refused when one statement mentions what another stores, or
 *                        when a statement that stores through memory shares the run with
 *                        a call.
 *   fold(V)              each value stored to local V is written into its uses up to the
 *                        next store to V, and the store goes; `*V` of a stored `&X` is X.
 *                        V's declaration goes once nothing names V. A compound store
 *                        `V op= K` right after the store is part of the value (E op K).
 *                        A use that copies V back into the place its value came from
 *                        (`S = X; ... X = S;`) stores nothing once folded and goes.
 *                        Refused when V's address is taken or a store in between writes a
 *                        name the value reads.
 *   cache(E,N,T[,@A])    a new local `T N = E;` before the statement storing A, or the
 *                        if/while/switch testing A (default: before the first statement
 *                        that evaluates E, in the innermost block holding every E), and
 *                        every E from there to the block's end reads N; for E = `&X`, each
 *                        X reads `*N` (`X.m` reads `N->m`). With an anchor, reads before it
 *                        keep E; `cache(E,N,T,@A,k)` moves only the first k reads. Refused
 *                        when E or a name in E is stored in that range.
 *   cache(E,N)           N is an existing local stored from E: each E after that store
 *                        reads N, up to the next store to E or N.
 *   own(V,T[,N])         V's initializer is a dead copy Ghidra merged into it: V is
 *                        declared as a T of its own (named N), without it; a cast of V or
 *                        &V to T or T* goes, and the declaration moves onto V's first
 *                        store when that is a plain store in the same block.
 *   guards(K[,i])        the i-th early return guarded by `!(c1 && ... && cn)` (or
 *                        `!c1 || ... || !cn`) becomes two: c1..cK, then the rest.
 *   merge-guards([i])    the i-th pair of adjacent early returns of one value becomes one
 *                        guard of both conditions.
 *   retval(V,K)          `V = K;` that ends an arm falling through to `return V;` becomes
 *                        `return K;`.
 *   width(V,T)           local V is declared T; a cast of V to T, a cast to V's old type
 *                        stored into V, and a cast of V to T's width in a truth test go.
 *   boolflag(V)          the bool local V, stored only `true`/`false` and read only as a
 *                        condition (an if/loop/`?:` test, an operand of `!`, `&&`, `||`), is
 *                        declared BOOL and stores 1/0: the original's flag lives in a 32-bit
 *                        register (`MOV EBX,1` / `TEST EBX,EBX`, FINDTILE_Register 0060cfa0).
 *                        Refused for any other store or read, or when V's address or size
 *                        is taken.
 *   retwiden(V)          the one- or two-byte integer local V, stored at least once from a
 *                        call, is declared int32_t and every value stored becomes `(T)E` for
 *                        its old type T: it holds what the narrow V held, and every read
 *                        promotes either to the same int (HandleMouseButtonEvent 0044c5e0, a
 *                        `MOVZX` once at the call instead of at each read). Refused when V's
 *                        address or size is taken, it is modified in place, or it is in a
 *                        brace-enclosed initializer.
 *   arms(C[,wrap][,i])   the if/else whose condition prints C is written with the
 *                        condition negated and the arms swapped; `wrap` negates a
 *                        condition that is not a comparison or `!x` as `!(C)`, not by
 *                        De Morgan (NPCMENU_OpenNpcShop 004b3d40, with zero(C)). Without
 *                        i the first if/else on C, else the i-th (in preorder); refused
 *                        when its else arm is an else-if chain.
 *
 * Control-flow forms (C is the printed condition of an `if` with no else; `[,i]` picks the
 * i-th such if, default 1):
 *
 *   nest(C[,i])          the guard `if (C) J` whose arm always leaves (ends in return,
 *                        break, continue or goto), followed by the rest R of its block, is
 *                        written `if (!C) { R } else J`.
 *   merge-tail(C[,i])    a guard `if (C) return E;` whose block ends in `return E;` is
 *                        written `if (!C) { the statements between }` before that return;
 *                        an if on C whose arm ends in `return E;` and falls through to
 *                        `return E;` loses the arm's copy.
 *   continue(C[,i])      the guard `if (C) J` that ends a loop body is written
 *                        `if (!C) continue;` followed by J's statements.
 *   select(C[,i])        the guard `if (C) return A;` followed by its block's last
 *                        statement `return B;` is written `return C ? A : B;`.
 *   unselect(C[,i])      `return C ? A : B;` is written `if (C) { return A; } return B;`.
 *   dup(S)               the expression statement S after an if/else (an else-if chain
 *                        with a final else) is written at the end of every arm instead;
 *                        refused when an arm can leave.
 *   hoist(S[,i])         the plain store S that begins the arm of an if with no else is
 *                        written just before the if (the decompiler sinks a store into the
 *                        only branch that reads it; the source as often wrote it above
 *                        the test, D2WINTIMER_GetElapsed 004fd8f0). Refused unless the
 *                        extra store on the untaken path is dead and nothing moves past
 *                        anything it depends on: S stores into a local named nowhere
 *                        outside the arm, its value loads no memory through a pointer,
 *                        divides by nothing and has no side effect, and C calls and
 *                        stores nothing.
 *
 * Expression forms (E and C are printed expressions; `[,i]` picks the i-th, default: the
 * only one):
 *
 *   tarms(C[,i])         the conditional `C ? A : B` is written `!C ? B : A`.
 *   zero(E[,i])          `!E` is written `E == 0`.
 *   bool(E[,i])          E tested for truth (as nonzero lists, or the operand of `!`, or
 *                        compared with 0 by == or !=) is written `(bool)(E)`, the same truth.
 *                        VC8 folds a tested bit `f >> n & 1` into `test dword ptr [f], 1<<n`;
 *                        converted to bool it keeps the shift, `shr; test` (CLIENT_Get-
 *                        EffectiveInventory 0046db30, GFX_LoadCompositCof 0046e740).
 *   nonzero(E[,i])       E tested for truth (an if, while or for condition, an operand of
 *                        `&&` or `||`, or the condition of `?:`) is written `E != 0`.
 *   cmp(C,F[,i])         the comparison C is spelled another way: F = mirror (`a < b` as
 *                        `b > a`), lit (an integer literal right side moved across the
 *                        bound: `a < N` as `a <= N-1`, `a >= N` as `a > N-1`, and back),
 *                        mirror-lit (both, in this order).
 *   swap(E[,i])          the commutative `a op b` (+ * & | ^) is written `b op a`.
 *   shift(E,H[,i])       the shift `E >> k` under a cast to an integer T of w bits, w + k <= 32
 *                        (not bool), is written arithmetic (H = sar: `(T)((int)E >> k)`, the
 *                        cast left out for a signed E) or logical (H = shr: `(T)((uint32_t)E
 *                        >> k)`, likewise). Both shift the same 32 bits; T drops the top k
 *                        bits where they differ. The decompiler prints a shift whose top bits
 *                        are dead as logical whatever the original did, and the high word
 *                        `(WORD)((DWORD)x >> 16)` is split: HIWORD in some functions (shr,
 *                        PATH_UpdateFixedPoint 00650660), a signed half in others (sar,
 *                        DATAARRAY_GetSlot 006bccd0). E must be a local or parameter of a
 *                        known integer type of at most 32 bits.
 *   ifsel(V)             `V = C ? A : B;` (or the declaration of V so initialized) is
 *                        written `if (C) { V = A; } else { V = B; }`.

 *   decl(V,W)            the declaration of V without an initializer moves to just before
 *                        the declaration of W in its block; refused when a statement it
 *                        moves past names V.
 *   split(V,T,N)         the store `V = E;` that begins a new life of V is written
 *                        `T N = E;` and that life's reads read N (E may read V: it reads
 *                        the old value, and keeps V); refused when V is read again after
 *                        them before a new store, or inside a loop.
 *   tsel(C[,i])          the i-th `if (C) { V1 = A1; ... } else { V1 = B1; ... }` storing the
 *                        same locals in both arms, followed by a call statement reading each
 *                        Vk once as a whole argument, is written with each read `C ? Ak : Bk`;
 *                        the if goes, and each Vk's declaration once nothing names it
 *                        (select-argument.ts, `selectPairedArguments`, says when it holds).
 *
 * Call and string-instruction forms (`[,i]` picks the i-th site, default: the only one):
 *
 *   nestcall(V[,i])      the store `V = F(...);` (or `T V = F(...);`) whose next statement
 *                        reads V once - as a whole call argument, or as the object of `->`
 *                        or `.` - is written with the call in that place, the store gone (a
 *                        declaration keeps `T V;` while V is named elsewhere). VC8 pushes
 *                        the arguments right of a nested call before calling it, as the
 *                        original does (Q04_ActiveFilter 00592fb0, `push 'bks '` before
 *                        `call GetGamePointer`). Refused unless V is a local whose address
 *                        is not taken, that is dead after that statement and whose type
 *                        cannot convert the value (no narrower, wider or floating
 *                        arithmetic type), and unless everything the statement may evaluate
 *                        before the call in its new place - the other arguments of each
 *                        call around it, the other operand of each operator, the callee -
 *                        calls nothing, stores nothing and reads only such locals and
 *                        constants; refused under `&&`, `||` or `?:` arms, which would make
 *                        the call conditional, and in a loop condition.
 *   fill(A[,i])          `memset(A[ + K], 0, N * sizeof(A[0]));` (or a byte count, A a
 *                        local array of a scalar whose size divides it), and the pointer
 *                        loop the string instruction decompiles to, `P = A; for (N = K; N;
 *                        N--) { P[0] = 0; ... P[m-1] = 0; P += m; }` (or `*P = 0; P++;`),
 *                        are written `for (int i = K; i < K + N; i++) A[i] = 0;` - VC8 never
 *                        expands a memset beyond 32 bytes, the original's inline stores
 *                        come from such a loop (SKILLDESC_FormatSignedValue 004e79e0,
 *                        AUTOMAP_DrawGamePassword 00459e90). The pointer loop's P and N
 *                        must be locals dead after it; refused when a bound leaves int.
 *   acc(E[,i])           the read E of a unit field, printed `X->F` (or `X->F.G`), that an
 *                        accessor of the tables names (`accessors`: a header inline that
 *                        returns the field, or a constant when X is null) is written as
 *                        the call of that accessor's inline twin, `A(X)`, defined once in
 *                        the unit ahead of the function (Vc8FormSite.prefix). The twin has
 *                        two returns, `if (X) { return X->F; } return K;`, and VC8 keeps
 *                        the value it returns in a register of its own where it folds a
 *                        plain read into the instruction that uses it
 *                        (MONSTERAI_IsValidResurrectionTarget 005eb650 `mov eax, [esi];
 *                        cmp eax, 1`, CLIENT_StoreUnitGuidForQuestTracking 0046bc70 `or
 *                        eax, -1; mov [g], eax`). A null test of X the read sits behind
 *                        goes with it where the accessor's K gives the same truth: `X &&
 *                        X->F == C` and `!X || X->F != C` for C other than K, and `X ?
 *                        X->F : K`; `acc(E[,i],bare)` leaves the test as printed and
 *                        writes the read alone (CLIENT_StoreUnitGuidForQuestTracking
 *                        0046bc70 keeps `!pUnit ? -1 : A(pUnit)`). X must name a pointer
 *                        to the accessor's struct and read nothing but names and members.
 *   retvar(C,N[,i])      the guard `if (C) { ...; return X; }` followed by the function's
 *                        last statement `return K;` (K a constant) is written with a result
 *                        variable: `T N = K;` just before the if, `N = X;` ending its arm,
 *                        and `return N;` - T the function's return type. VC8 returns the
 *                        K it put in a register for N (WEATHER_GetCurrentLevelWeatherFlags
 *                        00473770: `xor ecx, ecx` ... `mov eax, ecx`). Refused when the arm
 *                        leaves other than through its last return, or N names something.
 *   onecall(C,N[,i])     the guard `if (C) { F(..., X, ...); return; }` followed by the
 *                        function's last statement, the same call with Y in that one
 *                        argument, is written as one call: `T N; if (C) { N = X; } else {
 *                        N = Y; } F(..., N, ...);`, T the parameter's type. VC8 duplicates
 *                        the call into both arms itself and passes the zero arm's value
 *                        from a register (SUNITNPC_CloseNpcInteraction 00579130, `xor eax,
 *                        eax; push eax`). Refused unless every other argument loads nothing
 *                        and X and Y call and store nothing, as their evaluation moves
 *                        ahead of the other arguments.
 *   copy(D[,i])          the copy loop `for (N = K; N; N--) { *D = *S; S++; D++; }` is
 *                        written `memcpy(D, S, K * sizeof(*D));`, which VC8 expands to the
 *                        original's `rep movsd`. D and S must be declared pointers to one
 *                        type and, with N, locals dead after the loop; and the two ranges
 *                        provably apart: one of D and S is stored, in the loop's block and
 *                        outside any loop, the address of a local named nowhere before that
 *                        store - a loop copying within one buffer (Fog's D2Net 0040b0c0
 *                        smears zeros forward) is no memcpy.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, ConditionalExpr, CStyleCastExpr, DeclStmt, Expression,
  ExprStmt, ForStmt, FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, ParenExpr, ReturnStmt, Statement, SubscriptExpr, TranslationUnit,
  TypeNode, UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { cloneNode } from '../../transformer.js';
import { selectPairedArguments, SelectRefused, type SelectArgumentOptions } from './select-argument.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { calleeName, scopedLookup } from './call-arg-cast.js';

export type Vc8Form =
  | { op: 'seq'; targets: string[]; index?: number }
  | { op: 'fold'; name: string }
  | { op: 'cache'; expr: string; name: string; type?: string; anchor?: string; count?: number }
  | { op: 'own'; name: string; type: string; rename?: string }
  | { op: 'guards'; split: number; index: number }
  | { op: 'merge-guards'; index: number }
  | { op: 'retval'; name: string; value: string }
  | { op: 'width'; name: string; type: string }
  | { op: 'boolflag'; name: string }
  | { op: 'retwiden'; name: string }
  | { op: 'arms'; cond: string; wrap?: boolean; index?: number }
  | { op: 'nest'; cond: string; index: number }
  | { op: 'merge-tail'; cond: string; index: number }
  | { op: 'continue'; cond: string; index: number }
  | { op: 'dup'; stmt: string }
  | { op: 'hoist'; stmt: string; index: number }
  | { op: 'tarms'; cond: string; index: number }
  | { op: 'zero'; expr: string; index: number }
  | { op: 'nonzero'; expr: string; index: number }
  | { op: 'bool'; expr: string; index: number }
  | { op: 'cmp'; cond: string; how: 'mirror' | 'lit' | 'mirror-lit'; index: number }
  | { op: 'swap'; expr: string; index: number }
  | { op: 'ifsel'; name: string }
  | { op: 'select'; cond: string; index: number }
  | { op: 'decl'; name: string; before: string }
  | { op: 'unselect'; cond: string; index: number }
  | { op: 'split'; name: string; type: string; rename: string }
  | { op: 'tsel'; cond: string; index: number }
  | { op: 'nestcall'; name: string; index: number }
  | { op: 'fill'; name: string; index: number }
  | { op: 'copy'; name: string; index: number }
  | { op: 'shift'; expr: string; how: 'sar' | 'shr'; index: number }
  | { op: 'ptrwalk'; counter: string; array: string; name: string; type: string; index: number }
  | { op: 'rowptr'; expr: string; name: string; type: string; anchor?: string }
  | { op: 'acc'; expr: string; index: number; bare?: boolean }
  | { op: 'retvar'; cond: string; name: string; index: number }
  | { op: 'onecall'; cond: string; name: string; index: number };

/**
 * A header inline that reads one field of a struct through a pointer, or returns a
 * constant for a null pointer (D2Common::Units::GetGUID 00451f50): `acc` writes a read of
 * the field as a call of its twin, `call`, whose definition is `definition`.
 */
export interface Vc8Accessor {
  /** The struct the pointer points to, as types name it. */
  struct: string;
  /** The field read, outermost first: `['eAnimMode', 'ePlayerMode']`. */
  path: string[];
  /** The twin's name, as the call spells it. */
  call: string;
  /** The value the accessor returns for a null pointer. */
  dflt: bigint;
  /** The twin's definition, written once ahead of the first function that calls it. */
  definition: string;
}

/** The tables vc8-form reads: select-argument's, and the accessors `acc` writes. */
export type Vc8FormTables = SelectArgumentOptions & { accessors?: Vc8Accessor[] };

export interface Vc8FormSite {
  form: Vc8Form;
  /** The tag the form came from, for the report. */
  tag?: string;
  applied: boolean;
  why?: string;
  /** Definitions an applied form calls, to be written once ahead of the function (`acc`). */
  prefix?: string[];
}

export interface Vc8FormOptions {
  forms: Array<{ form: Vc8Form; tag?: string }>;
  onSite?: (site: Vc8FormSite) => void;
  /** The tables tsel types the values of an if/else from, and the accessors acc writes. */
  selectTables?: Vc8FormTables;
}

const OPS = new Set(['seq', 'fold', 'cache', 'own', 'guards', 'merge-guards', 'retval', 'width', 'boolflag', 'retwiden', 'arms',
  'nest', 'merge-tail', 'continue', 'dup', 'tarms', 'zero', 'nonzero', 'bool', 'cmp', 'swap', 'ifsel', 'split', 'select', 'decl', 'unselect', 'tsel', 'hoist',
  'nestcall', 'fill', 'copy', 'shift', 'ptrwalk', 'rowptr', 'acc', 'retvar', 'onecall']);

/** Split at the commas outside brackets, parentheses, angle-free. */
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '' || out.length > 0) out.push(cur.trim());
  return out;
}

/**
 * Parse the form part of a tag: `op(arg,...)`. Returns undefined for an unknown op or a
 * wrong argument count.
 */
export function parseVc8Form(text: string): Vc8Form | undefined {
  const m = /^\s*([a-z-]+)\s*\(([\s\S]*)\)\s*$/.exec(text);
  if (!m || !OPS.has(m[1])) return undefined;
  const args = splitArgs(m[2]);
  const anchor = args.length > 0 && args[args.length - 1].startsWith('@') ? args.pop()!.slice(1) : undefined;
  const int = (s: string | undefined, d: number) => (s === undefined || s === '' ? d : /^\d+$/.test(s) ? Number(s) : NaN);
  switch (m[1]) {
    case 'seq': {
      // `seq(a,b,@N)`: the N-th run, when several store these.
      const n = anchor === undefined ? 0 : /^\d+$/.test(anchor) ? Number(anchor) : NaN;
      return args.length >= 2 && (n === 0 || n >= 1) ? { op: 'seq', targets: args, ...(n ? { index: n } : {}) } : undefined;
    }
    case 'fold': return args.length === 1 && !anchor ? { op: 'fold', name: args[0] } : undefined;
    case 'cache':
      if (args.length === 2 && !anchor) return { op: 'cache', expr: args[0], name: args[1] };
      if (args.length === 3) return { op: 'cache', expr: args[0], name: args[1], type: args[2], anchor };
      // `cache(E,N,T,@A,k)`: only the first k reads from the anchor on.
      if (!anchor && args.length === 5 && args[3].startsWith('@') && int(args[4], NaN) >= 1) {
        return { op: 'cache', expr: args[0], name: args[1], type: args[2], anchor: args[3].slice(1), count: int(args[4], NaN) };
      }
      return undefined;
    case 'own':
      if (anchor || args.length < 2 || args.length > 3) return undefined;
      return { op: 'own', name: args[0], type: args[1], rename: args[2] };
    case 'guards': {
      const k = int(args[0], NaN), i = int(args[1], 1);
      return !anchor && args.length <= 2 && k >= 1 && i >= 1 ? { op: 'guards', split: k, index: i } : undefined;
    }
    case 'merge-guards': {
      const i = int(args[0], 1);
      return !anchor && args.length <= 1 && i >= 1 ? { op: 'merge-guards', index: i } : undefined;
    }
    case 'retval': return args.length === 2 && !anchor ? { op: 'retval', name: args[0], value: args[1] } : undefined;
    case 'width': return args.length === 2 && !anchor ? { op: 'width', name: args[0], type: args[1] } : undefined;
    case 'boolflag': case 'retwiden':
      return args.length === 1 && !anchor && /^[A-Za-z_]\w*$/.test(args[0]) ? { op: m[1], name: args[0] } as Vc8Form : undefined;
    case 'arms': {
      // `arms(C)`, `arms(C,wrap)`, `arms(C,i)`, `arms(C,wrap,i)`.
      if (anchor || args.length < 1 || args.length > 3 || args[0] === '') return undefined;
      const rest = args.slice(1);
      const wrap = rest[0] === 'wrap';
      if (wrap) rest.shift();
      if (rest.length > 1 || (rest.length === 1 && !/^[1-9]\d*$/.test(rest[0]))) return undefined;
      return { op: 'arms', cond: args[0], ...(wrap ? { wrap: true } : {}), ...(rest.length ? { index: Number(rest[0]) } : {}) };
    }
    case 'ptrwalk': {
      // `ptrwalk(i,X,N,T)`, `ptrwalk(i,X,N,T,k)`: the k-th for loop counting i.
      const i = int(args[4], 0);
      if (anchor || args.length < 4 || args.length > 5 || !(i >= 0) || !/^[A-Za-z_]\w*$/.test(args[0])
        || !/^[A-Za-z_][\w:]*$/.test(args[1]) || !/^[A-Za-z_]\w*$/.test(args[2]) || args[3] === '') return undefined;
      return { op: 'ptrwalk', counter: args[0], array: args[1], name: args[2], type: args[3], index: i };
    }
    case 'rowptr':
      // `rowptr(X[I],N,T)`, `rowptr(X[I],N,T,@A)`.
      if (args.length !== 3 || !/\]$/.test(args[0]) || !/^[A-Za-z_]\w*$/.test(args[1]) || args[2] === '') return undefined;
      return { op: 'rowptr', expr: args[0], name: args[1], type: args[2], ...(anchor ? { anchor } : {}) };
    case 'nestcall': case 'fill': case 'copy': {
      const i = int(args[1], 0);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 0) || !/^[A-Za-z_]\w*$/.test(args[0])) return undefined;
      return { op: m[1], name: args[0], index: i } as Vc8Form;
    }
    case 'nest': case 'merge-tail': case 'continue': case 'select': case 'tsel': {
      const i = int(args[1], 1);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 1) || args[0] === '') return undefined;
      return { op: m[1], cond: args[0], index: i } as Vc8Form;
    }
    case 'retvar': case 'onecall': {
      const i = int(args[2], 1);
      if (anchor || args.length < 2 || args.length > 3 || !(i >= 1) || args[0] === '' || !/^[A-Za-z_]\w*$/.test(args[1])) return undefined;
      return { op: m[1], cond: args[0], name: args[1], index: i } as Vc8Form;
    }
    case 'acc': {
      // `acc(E)`, `acc(E,i)`, `acc(E,bare)`, `acc(E,i,bare)`.
      const rest = args.slice(1);
      const bare = rest[rest.length - 1] === 'bare';
      if (bare) rest.pop();
      const i = int(rest[0], 0);
      if (anchor || args.length < 1 || rest.length > 1 || !(i >= 0) || args[0] === '') return undefined;
      return { op: 'acc', expr: args[0], index: i, ...(bare ? { bare: true } : {}) };
    }
    case 'zero': case 'nonzero': case 'bool': case 'swap': case 'tarms': case 'unselect': {
      const i = int(args[1], 0);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 0) || args[0] === '') return undefined;
      return (m[1] === 'tarms' || m[1] === 'unselect' ? { op: m[1], cond: args[0], index: i } : { op: m[1], expr: args[0], index: i }) as Vc8Form;
    }
    case 'shift': {
      const i = int(args[2], 0);
      if (anchor || args.length < 2 || args.length > 3 || !(i >= 0) || args[0] === '') return undefined;
      if (args[1] !== 'sar' && args[1] !== 'shr') return undefined;
      return { op: 'shift', expr: args[0], how: args[1], index: i };
    }
    case 'cmp': {
      const i = int(args[2], 0);
      if (anchor || args.length < 2 || args.length > 3 || !(i >= 0)) return undefined;
      if (args[1] !== 'mirror' && args[1] !== 'lit' && args[1] !== 'mirror-lit') return undefined;
      return { op: 'cmp', cond: args[0], how: args[1], index: i };
    }
    case 'dup': return args.length === 1 && !anchor && args[0] !== '' ? { op: 'dup', stmt: args[0] } : undefined;
    case 'hoist': {
      const i = int(args[1], 0);
      if (anchor || args.length < 1 || args.length > 2 || !(i >= 0) || args[0] === '') return undefined;
      return { op: 'hoist', stmt: args[0], index: i };
    }
    case 'ifsel': return args.length === 1 && !anchor ? { op: 'ifsel', name: args[0] } : undefined;
    case 'decl': return args.length === 2 && !anchor ? { op: 'decl', name: args[0], before: args[1] } : undefined;
    case 'split': return args.length === 3 && !anchor ? { op: 'split', name: args[0], type: args[1], rename: args[2] } : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Text, parsing, walking

// Namespace qualifiers are dropped as `dh` drops them: a tag names a site in the text
// it was measured on, and a symbol that moves to a module namespace afterwards
// (`sgptDataTable` -> `D2Common::ITEMS::Items::sgptDataTable`) is the same site.
const norm = (s: string) => s.replace(/\s+/g, '').replace(/(?<![\w:])(?:::)?(?:[A-Za-z_]\w*::)+(?=[A-Za-z_~])/g, '');
const text = (n: ASTNode) => norm(emit(n as never));

function unparen(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

function parseType(t: string): TypeNode {
  const fn = parse(`void __vc8f() { ${t} __vc8v = 0; }`).declarations[0] as FunctionDecl;
  const d = fn.body!.statements[0] as DeclStmt;
  if (d.kind !== NodeKind.DeclStmt) throw new Error(`not a type: ${t}`);
  return (d.declarations[0] as VariableDecl).type;
}

function parseExpr(e: string): Expression {
  const fn = parse(`void __vc8f() { __vc8x = (${e}); }`).declarations[0] as FunctionDecl;
  const s = fn.body!.statements[0] as ExprStmt;
  if (s.kind !== NodeKind.ExprStmt) throw new Error(`not an expression: ${e}`);
  return unparen((s.expression as AssignExpr).right);
}

interface Slot { parent: Record<string, unknown> | unknown[]; key: string | number }

/**
 * Every node under root, preorder, with the slot that holds it. A member's name is no
 * variable and is not visited.
 */
function* walk(root: ASTNode, slot?: Slot): Generator<{ node: ASTNode; slot?: Slot }> {
  yield { node: root, slot };
  for (const key of Object.keys(root)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    if (key === 'member' && root.kind === NodeKind.MemberExpr) continue;
    const v = (root as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') yield* walk(x as ASTNode, { parent: v, key: i });
      }
    } else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') {
      yield* walk(v as ASTNode, { parent: root as unknown as Record<string, unknown>, key });
    }
  }
}

function put(slot: Slot, n: ASTNode): void {
  (slot.parent as Record<string | number, unknown>)[slot.key as never] = n;
}

const isId = (e: ASTNode | null | undefined, name?: string): e is Identifier =>
  !!e && e.kind === NodeKind.Identifier && (name === undefined || (e as Identifier).name === name);

function mentions(n: ASTNode, name: string): boolean {
  for (const { node } of walk(n)) if (isId(node, name)) return true;
  return false;
}

function hasCall(n: ASTNode): boolean {
  for (const { node } of walk(n)) if (node.kind === NodeKind.CallExpr) return true;
  return false;
}

/** The plain store `L = R;` a statement is, or undefined. */
function storeOf(s: Statement): AssignExpr | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? (e as AssignExpr) : undefined;
}

/** The single variable a declaration statement declares. */
function declOf(s: Statement): VariableDecl | undefined {
  if (s.kind !== NodeKind.DeclStmt) return undefined;
  const d = (s as DeclStmt).declarations;
  return d.length === 1 && d[0].kind === NodeKind.VariableDecl ? (d[0] as VariableDecl) : undefined;
}

/** What a statement stores to, as printed: the store's left side, or the declared name. */
function targetOf(s: Statement): string | undefined {
  const st = storeOf(s);
  if (st) return text(st.left);
  // A declaration without an initializer stores nothing.
  const d = declOf(s);
  return d && d.initializer ? d.name.name : undefined;
}

function blocks(fn: FunctionDecl): CompoundStmt[] {
  const out: CompoundStmt[] = [];
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.CompoundStmt) out.push(node as CompoundStmt);
  return out;
}

/** Root names an lvalue stores into: `x` for x, x.f, x[i]; '*' for memory through a pointer or a global. */
function storeRoot(e: Expression, locals: Set<string>): string {
  e = unparen(e);
  for (;;) {
    if (isId(e)) return locals.has(e.name) ? e.name : '*';
    if (e.kind === NodeKind.MemberExpr && !(e as unknown as { isArrow: boolean }).isArrow) { e = unparen((e as unknown as { object: Expression }).object); continue; }
    if (e.kind === NodeKind.SubscriptExpr) {
      const a = unparen((e as unknown as { array: Expression }).array);
      if (isId(a) && locals.has(a.name)) { e = a; continue; }
    }
    return '*';
  }
}

function localNames(fn: FunctionDecl): Set<string> {
  const out = new Set<string>();
  for (const p of fn.parameters) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && isId(n)) out.add(n.name);
  }
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.VariableDecl) out.add((node as VariableDecl).name.name);
  return out;
}

/** Every `&name` is the operand of a cast to a pointer type. */
function addressOnlyCast(fn: FunctionDecl, name: string): boolean {
  const parents = parentsOf(fn);
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.UnaryExpr || (node as UnaryExpr).operator !== '&' || !isId(unparen((node as UnaryExpr).operand), name)) continue;
    let p = parents.get(node);
    while (p && p.kind === NodeKind.ParenExpr) p = parents.get(p);
    if (!p || p.kind !== NodeKind.CStyleCastExpr || !text((p as CStyleCastExpr).type).includes('*')) return false;
  }
  return true;
}

function addressTaken(fn: FunctionDecl, name: string): boolean {
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && isId(unparen((node as UnaryExpr).operand), name)) return true;
  }
  return false;
}

/** Variables a statement stores into (assignment, compound assignment, ++/--). */
function storedNames(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const { node } of walk(n)) {
    let lhs: Expression | undefined;
    if (node.kind === NodeKind.AssignExpr) lhs = (node as AssignExpr).left;
    else if ((node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator)) || node.kind === NodeKind.PostfixExpr) lhs = (node as UnaryExpr).operand;
    if (!lhs) continue;
    // The variable the store lands in: through `.` and `[]`; a store through `*` or `->`
    // writes memory, not the pointer.
    let e = unparen(lhs);
    while (e.kind === NodeKind.SubscriptExpr || (e.kind === NodeKind.MemberExpr && !(e as unknown as { isArrow: boolean }).isArrow)) {
      e = unparen(e.kind === NodeKind.SubscriptExpr ? (e as unknown as { array: Expression }).array : (e as unknown as { object: Expression }).object);
    }
    if (isId(e)) out.add(e.name);
  }
  return out;
}

function identifiers(n: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const { node } of walk(n)) if (isId(node)) out.add(node.name);
  return out;
}

/** The negation of a condition, pushed through comparisons and De Morgan. */
const FLIP: Record<string, string> = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
function negate(c: Expression): Expression {
  c = unparen(c);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return unparen((c as UnaryExpr).operand);
  if (c.kind === NodeKind.BinaryExpr) {
    const b = c as BinaryExpr;
    if (FLIP[b.operator]) return { ...b, operator: FLIP[b.operator] as BinaryExpr['operator'] };
    if (b.operator === '||') return { ...b, operator: '&&', left: negate(b.left), right: negate(b.right) };
    if (b.operator === '&&') return { ...b, operator: '||', left: negate(b.left), right: negate(b.right) };
  }
  return { kind: NodeKind.UnaryExpr, operator: '!', operand: c } as unknown as UnaryExpr;
}

/** The negation the control-flow forms write: a comparison flipped, `!x` as x, anything else as `!(c)`. */
function negateWrap(c: Expression): Expression {
  c = unparen(c);
  if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') return unparen((c as UnaryExpr).operand);
  if (c.kind === NodeKind.BinaryExpr && FLIP[(c as BinaryExpr).operator]) return { ...(c as BinaryExpr), operator: FLIP[(c as BinaryExpr).operator] as BinaryExpr['operator'] };
  return { kind: NodeKind.UnaryExpr, operator: '!', operand: { kind: NodeKind.ParenExpr, expression: c } } as unknown as UnaryExpr;
}

function chain(c: Expression, op: '&&' | '||'): Expression[] {
  c = unparen(c);
  if (c.kind === NodeKind.BinaryExpr && (c as BinaryExpr).operator === op) {
    return [...chain((c as BinaryExpr).left, op), ...chain((c as BinaryExpr).right, op)];
  }
  return [c];
}

function join(parts: Expression[], op: '&&' | '||'): Expression {
  return parts.reduce((l, r) => ({ kind: NodeKind.BinaryExpr, operator: op, left: l, right: r }) as unknown as BinaryExpr);
}

/** The single `return R;` an if's then-branch is, or undefined. */
function soleReturn(s: Statement): ReturnStmt | undefined {
  if (s.kind === NodeKind.ReturnStmt) return s as ReturnStmt;
  if (s.kind === NodeKind.CompoundStmt) {
    const st = (s as CompoundStmt).statements;
    if (st.length === 1 && st[0].kind === NodeKind.ReturnStmt) return st[0] as ReturnStmt;
  }
  return undefined;
}

class Refuse extends Error {}
const refuse = (why: string): never => { throw new Refuse(why); };

// ---------------------------------------------------------------------------------------
// The forms

/** What a statement stores to for seq: a plain or compound store, ++/--, or an initialized declaration. */
function seqLhs(s: Statement): Expression | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  if (e.kind === NodeKind.AssignExpr) return (e as AssignExpr).left;
  if (e.kind === NodeKind.PostfixExpr || (e.kind === NodeKind.UnaryExpr && ['++', '--'].includes((e as UnaryExpr).operator))) return (e as UnaryExpr).operand;
  return undefined;
}

function seqTargetOf(s: Statement): string | undefined {
  const l = seqLhs(s);
  return l ? text(l) : targetOf(s);
}

function doSeq(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'seq' }>): void {
  const want = f.targets.map(norm);
  if (new Set(want).size !== want.length) refuse('a target listed twice');
  const locals = localNames(fn);
  // The runs that store exactly these and are not in the listed order yet; one is the site.
  const runs: Array<{ st: Statement[]; i: number; got: string[] }> = [];
  for (const b of blocks(fn)) {
    const st = b.statements;
    for (let i = 0; i + want.length <= st.length; i++) {
      const got = st.slice(i, i + want.length).map(s => seqTargetOf(s));
      if (!got.every(g => g !== undefined && want.includes(g)) || new Set(got).size !== want.length) continue;
      if (got.every((g, k) => g === want[k])) continue;
      runs.push({ st, i, got: got as string[] });
    }
  }
  if (runs.length === 0) refuse('no adjacent run out of this order stores exactly these');
  if (runs.length > 1 && !f.index) refuse(`${runs.length} runs store these`);
  if (f.index && f.index > runs.length) refuse(`no run #${f.index} stores these`);
  {
    const { st, i, got } = runs[(f.index ?? 1) - 1];
    {
      const run = st.slice(i, i + want.length);
      // Value-preserving: no statement mentions what another stores, and a store through
      // memory shares the run with no call.
      // Only a pair whose order the move flips can change a value.
      const pos = got.map(g => want.indexOf(g!));
      const reads = (hay: string, needle: string) => new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9_])').test(hay);
      for (let x = 0; x < run.length; x++) {
        const lx = seqLhs(run[x]);
        const tx = got[x]!;
        for (let y = 0; y < run.length; y++) {
          if (x === y) continue;
          if ((x < y) === (pos[x] < pos[y])) continue;
          const ly = seqLhs(run[y]);
          if (!lx) {
            if (mentions(run[y], tx)) refuse(`${tx} is used by ${got[y]}`);
            continue;
          }
          const root = storeRoot(lx, locals);
          if (root === '*') {
            if (hasCall(run[x]) || hasCall(run[y])) refuse(`${tx} stores through memory beside a call`);
            if (reads(text(run[y]), tx)) refuse(`${tx} is read by ${got[y]}`);
            continue;
          }
          // A local: another member store into the same local is independent unless it
          // reads this member; anything else must not name the local at all.
          const sy = storeOf(run[y]);
          const sameAggregate = ly && storeRoot(ly, locals) === root && text(ly) !== root;
          // The other statement's reads: a plain store's right side; a compound store or
          // ++/-- also reads its own target.
          const readsOfY = sy && sy.operator === '=' ? text(sy.right) : text(run[y]);
          if (sameAggregate ? reads(readsOfY, tx) : mentions(run[y], root)) refuse(`${tx} is read by ${got[y]}`);
        }
      }
      const byTarget = new Map(run.map((s, k) => [got[k]!, s]));
      st.splice(i, want.length, ...want.map(w => byTarget.get(w)!));
    }
  }
}

const IN_PLACE = new Set(['+=', '-=', '*=', '&=', '|=', '^=', '<<=', '>>=']);

function doFold(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'fold' }>): void {
  const v = f.name;
  if (addressTaken(fn, v)) refuse(`&${v} is taken`);
  let folded = 0;
  for (const b of blocks(fn)) {
    for (let i = 0; i < b.statements.length; i++) {
      const s = b.statements[i];
      const st = storeOf(s);
      const d = declOf(s);
      let value: Expression | null = null;
      if (st && st.operator === '=' && isId(unparen(st.left), v)) value = st.right;
      else if (d && d.name.name === v && d.initializer && d.initializer.kind !== NodeKind.InitListExpr) value = d.initializer as Expression;
      if (!value) continue;
      if (mentions(value, v)) refuse(`${v} is stored from itself`);
      // A compound store right after it works on the value in place (`V = E; V -= K;`, as
      // in-place-operand writes the `E - K` VC8 computes in its register): the value is
      // `E - K`. K must not read V or call anything.
      let absorbed = 0;
      while (i + 1 + absorbed < b.statements.length) {
        const c = storeOf(b.statements[i + 1 + absorbed]);
        if (!c || !IN_PLACE.has(c.operator) || !isId(unparen(c.left), v) || mentions(c.right, v) || hasCall(c.right)) break;
        value = { kind: NodeKind.BinaryExpr, operator: c.operator.slice(0, -1), left: value, right: c.right } as unknown as BinaryExpr;
        absorbed++;
      }
      // Its uses: the following statements of this block, up to the next store to v.
      let end = i + 1 + absorbed;
      while (end < b.statements.length) {
        const n = b.statements[end];
        const ns = storeOf(n);
        if ((ns && ns.operator === '=' && isId(unparen(ns.left), v)) || (declOf(n)?.name.name === v)) break;
        end++;
      }
      const reads = identifiers(value);
      const uses = b.statements.slice(i + 1 + absorbed, end);
      const lastUse = uses.reduce((k, n, j) => (mentions(n, v) ? j : k), -1);
      if (lastUse < 0) refuse(`the value stored to ${v} is never read`);
      for (let j = 0; j <= lastUse; j++) {
        const stored = storedNames(uses[j]);
        if (stored.has(v)) refuse(`${v} is stored again inside its uses`);
        if (j < lastUse) for (const r of reads) if (stored.has(r)) refuse(`${r} changes before ${v} is read`);
      }
      // Nothing after the range may read this value: the range ends at a store or at the
      // block's end, and the block must not be followed by a read in an outer block.
      if (end === b.statements.length && blockReadsAfter(fn, b, v, i, true)) refuse(`${v} is read after its block`);
      const backCopies = copiesBack(uses.slice(0, lastUse + 1), v, value);
      for (const n of uses.slice(0, lastUse + 1)) {
        for (const { node, slot } of [...walk(n)]) {
          if (!slot) continue;
          if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '*' && isId(unparen((node as UnaryExpr).operand), v)) {
            const inner = unparen(value);
            if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&') put(slot, cloneNode(unparen((inner as UnaryExpr).operand)));
            else put(slot, { kind: NodeKind.UnaryExpr, operator: '*', operand: cloneNode(value) } as unknown as UnaryExpr);
          }
        }
        for (const { node, slot } of [...walk(n)]) if (slot && isId(node, v)) put(slot, cloneNode(value));
      }
      removeStatements(fn, backCopies);
      b.statements.splice(i, 1 + absorbed);
      i--;
      folded++;
    }
  }
  if (folded === 0) refuse(`no store to ${v}`);
  // The bare declaration goes once nothing names v.
  if (!mentionsOutsideDecl(fn, v)) removeDecl(fn, v);
}

/**
 * The statements among `uses` that store V back into the place its value `value` was read
 * from, `X = V;` for a value X: once V is written into them they read `X = X;`, a store of
 * nothing. Only where X is an lvalue with no call and no store of its own in it, so the
 * statement has no effect to keep; and only a statement in a block, which can go.
 */
function copiesBack(uses: Statement[], v: string, value: Expression): Set<ASTNode> {
  const out = new Set<ASTNode>();
  const x = unparen(value);
  if (hasCall(x) || storedNames(x).size > 0) return out;
  if (x.kind !== NodeKind.Identifier && x.kind !== NodeKind.MemberExpr && x.kind !== NodeKind.SubscriptExpr) return out;
  const xt = text(x);
  for (const n of uses) {
    for (const { node, slot } of walk(n)) {
      if (node.kind !== NodeKind.ExprStmt || (slot && !Array.isArray(slot.parent))) continue;
      const s = storeOf(node as Statement);
      if (s && s.operator === '=' && isId(unparen(s.right), v) && text(unparen(s.left)) === xt) out.add(node);
    }
  }
  return out;
}

/** Take each of `gone` out of the block that holds it. */
function removeStatements(fn: FunctionDecl, gone: Set<ASTNode>): void {
  if (gone.size === 0) return;
  for (const b of blocks(fn)) {
    for (let k = b.statements.length - 1; k >= 0; k--) if (gone.has(b.statements[k])) b.statements.splice(k, 1);
  }
}

function parentsOf(fn: FunctionDecl): Map<ASTNode, ASTNode> {
  const m = new Map<ASTNode, ASTNode>();
  const rec = (n: ASTNode) => {
    for (const { node, slot } of walk(n)) {
      if (!slot) continue;
      const p = Array.isArray(slot.parent) ? undefined : (slot.parent as unknown as ASTNode);
      if (p) m.set(node, p);
    }
  };
  rec(fn.body!);
  // Array slots: map the array's items to the node owning the array.
  for (const { node } of walk(fn.body!)) {
    for (const key of Object.keys(node)) {
      const v = (node as unknown as Record<string, unknown>)[key];
      if (Array.isArray(v)) for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') m.set(x as ASTNode, node);
    }
  }
  return m;
}

const LIFE_JUMPS = new Set<string>([NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt]);

/**
 * What a statement does to v first on its way through: `store` when every path through it
 * stores v before reading it, `read` when a path may read it first (or the statement jumps,
 * so its paths are not followed), `none` when some path leaves it without naming v.
 */
function readFirst(s: Statement, v: string): 'read' | 'store' | 'none' {
  for (const { node } of walk(s)) if (LIFE_JUMPS.has(node.kind)) return 'read';
  const st = storeOf(s);
  if (st && st.operator === '=' && isId(unparen(st.left), v)) return mentions(st.right, v) ? 'read' : 'store';
  const d = declOf(s);
  if (d && d.name.name === v) return d.initializer && mentions(d.initializer, v) ? 'read' : 'store';
  if (s.kind === NodeKind.CompoundStmt) {
    for (const x of (s as CompoundStmt).statements) {
      const r = readFirst(x, v);
      if (r !== 'none') return r;
    }
    return 'none';
  }
  if (s.kind === NodeKind.IfStmt) {
    const i = s as IfStmt;
    if (i.init || mentions(i.condition, v)) return 'read';
    const a = readFirst(i.thenBranch, v);
    const b = i.elseBranch ? readFirst(i.elseBranch, v) : 'none';
    if (a === 'read' || b === 'read') return 'read';
    // One arm stores and the other does not: the other's path goes on to what follows.
    return a === 'store' && b === 'store' ? 'store' : 'none';
  }
  return mentions(s, v) ? 'read' : 'none';
}

/**
 * Whether a statement after block b (in an enclosing block) names v. With `from`, the index
 * in b of the store whose value ends with b, a loop around b counts only where the next
 * iteration reads v before that store: its condition and increment, and the statements
 * before the path to the store (in b, those before `from`); without it, any mention in the
 * loop counts.
 */
function blockReadsAfter(fn: FunctionDecl, b: CompoundStmt, v: string, from?: number, storeEnds = false): boolean {
  const parents = parentsOf(fn);
  let cur: ASTNode = b;
  // The statements before the path, from b outwards to the innermost loop.
  const before: Statement[] = from === undefined ? [] : b.statements.slice(0, from);
  for (;;) {
    const p = parents.get(cur);
    if (!p) return false;
    if (p.kind === NodeKind.CompoundStmt) {
      const st = (p as CompoundStmt).statements;
      const k = st.indexOf(cur as Statement);
      // A jump between this block and a store may skip the store: after one, any mention
      // reads, as before.
      let jumped = !storeEnds;
      for (const s of st.slice(k + 1)) {
        if (!mentions(s, v)) {
          if (!jumped) for (const { node } of walk(s)) if (LIFE_JUMPS.has(node.kind)) { jumped = true; break; }
          continue;
        }
        if (jumped) return true;
        const r = readFirst(s, v);
        if (r === 'read') return true;
        // Stored on every path before any read: the value of this life ends here, here
        // and in every enclosing block and loop.
        if (r === 'store') return false;
        for (const { node } of walk(s)) if (LIFE_JUMPS.has(node.kind)) { jumped = true; break; }
      }
      before.push(...st.slice(0, k));
    }
    if (p.kind === NodeKind.WhileStmt || p.kind === NodeKind.ForStmt || p.kind === NodeKind.DoWhileStmt) {
      if (from === undefined) { if (mentions(p, v)) return true; }
      else {
        const l = p as unknown as { condition?: ASTNode | null; increment?: ASTNode | null; init?: ASTNode | null };
        if ((l.condition && mentions(l.condition, v)) || (l.increment && mentions(l.increment, v))) return true;
        if (before.some(s => mentions(s, v))) return true;
      }
    }
    cur = p;
  }
}

function mentionsOutsideDecl(fn: FunctionDecl, v: string): boolean {
  for (const { node, slot } of walk(fn.body!)) {
    if (!isId(node, v)) continue;
    const owner = slot && !Array.isArray(slot.parent) ? (slot.parent as unknown as ASTNode) : undefined;
    if (owner && owner.kind === NodeKind.VariableDecl && slot!.key === 'name') continue;
    return true;
  }
  return false;
}

function removeDecl(fn: FunctionDecl, v: string): void {
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => declOf(s)?.name.name === v);
    if (k >= 0) { b.statements.splice(k, 1); return; }
  }
}

/** The statement an anchor names: the one storing (or declaring) it, or the if/while/switch on it. */
function anchors(s: Statement, a: string): boolean {
  if (targetOf(s) === a) return true;
  if (s.kind === NodeKind.IfStmt || s.kind === NodeKind.WhileStmt || s.kind === NodeKind.SwitchStmt) return text((s as IfStmt).condition) === a;
  return false;
}

function doCache(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'cache' }>): void {
  // `&X` caches X's address: each X is read through the local, `X.m` as `N->m`.
  const byAddress = f.type !== undefined && norm(f.expr).startsWith('&');
  const want = byAddress ? norm(f.expr).slice(1) : norm(f.expr);
  const locals = localNames(fn);
  const isE = (n: ASTNode) => (n as Expression).kind !== undefined && text(n) === want;
  const stores = (n: ASTNode) => {
    for (const { node } of walk(n)) {
      if (node.kind !== NodeKind.AssignExpr) continue;
      const l = text((node as AssignExpr).left);
      if (l === want || identifiers((node as AssignExpr).left).has(f.name)) return true;
      if (isId(unparen((node as AssignExpr).left)) && identifiers(parseExpr(f.expr)).has((unparen((node as AssignExpr).left) as Identifier).name)) return true;
    }
    return false;
  };
  const replaceIn = (n: ASTNode): number => {
    let k = 0;
    for (const { node, slot } of [...walk(n)]) {
      if (!slot || !isE(node)) continue;
      const owner = !Array.isArray(slot.parent) ? (slot.parent as unknown as ASTNode) : undefined;
      if (owner && owner.kind === NodeKind.AssignExpr && slot.key === 'left') refuse(`${f.expr} is stored`);
      const id = { kind: NodeKind.Identifier, name: f.name } as Identifier;
      if (!byAddress) put(slot, id);
      else if (owner && owner.kind === NodeKind.MemberExpr && slot.key === 'object' && !(owner as unknown as { isArrow: boolean }).isArrow) {
        (owner as unknown as { object: Expression }).object = id;
        (owner as unknown as { isArrow: boolean }).isArrow = true;
      } else put(slot, { kind: NodeKind.UnaryExpr, operator: '*', operand: id } as unknown as UnaryExpr);
      k++;
    }
    return k;
  };
  if (f.type) {
    if (locals.has(f.name)) refuse(`${f.name} exists`);
    let block: CompoundStmt | undefined, at = -1;
    if (f.anchor) {
      const a = norm(f.anchor);
      for (const b of blocks(fn)) { const k = b.statements.findIndex(s => anchors(s, a)); if (k >= 0) { block = b; at = k; break; } }
      if (!block) refuse(`no statement stores or tests ${f.anchor}`);
    } else {
      // The innermost block whose statements hold every E.
      const all = blocks(fn).filter(b => b.statements.some(s => [...walk(s)].some(x => isE(x.node))));
      const total = [...walk(fn.body!)].filter(x => isE(x.node)).length;
      if (total === 0) refuse(`${f.expr} does not occur`);
      for (const b of all.reverse()) {
        const inB = b.statements.reduce((k, s) => k + [...walk(s)].filter(x => isE(x.node)).length, 0);
        if (inB === total) { block = b; at = b.statements.findIndex(s => [...walk(s)].some(x => isE(x.node))); break; }
      }
      if (!block) refuse(`no block holds every ${f.expr}`);
    }
    const rest = block!.statements.slice(at);
    const reads = (s: ASTNode) => [...walk(s)].filter(x => isE(x.node)).length;
    // Without an anchor every read is after the local; with one, reads before it keep E.
    const before = reads(fn.body!) - rest.reduce((k, s) => k + reads(s), 0);
    if (before > 0 && !f.anchor) refuse(`${f.expr} is read before the new local`);
    // The statements whose reads move to the local: all of them, or the first `count` reads.
    let last = -1, seen = 0;
    for (let k = 0; k < rest.length && seen < (f.count ?? Infinity); k++) { const r = reads(rest[k]); if (r > 0) { last = k; seen += r; } }
    if (last < 0) refuse(`${f.expr} is not read after the anchor`);
    if (f.count !== undefined && seen !== f.count) refuse(`the first ${f.count} reads of ${f.expr} do not end a statement`);
    for (let k = 0; k < last; k++) if (stores(rest[k])) refuse(`${f.expr} changes before its last read`);
    let n = 0;
    for (const s of rest.slice(0, last + 1)) n += replaceIn(s);
    const decl = parse(`void __vc8f() { ${f.type} ${f.name} = ${f.expr}; }`).declarations[0] as FunctionDecl;
    const d = decl.body!.statements[0];
    if (!declOf(d)) refuse(`cannot declare ${f.type} ${f.name}`);
    (declOf(d)!).type = parseType(f.type);
    block!.statements.splice(at, 0, d);
    if (n === 0) refuse('nothing to read the local');
    return;
  }
  // N exists and is stored from E: the reads of E that follow its store read N.
  if (!locals.has(f.name)) refuse(`${f.name} is no local`);
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => {
      const st = storeOf(s); const d = declOf(s);
      return (st && st.operator === '=' && isId(unparen(st.left), f.name) && text(st.right) === want) ||
        (d && d.name.name === f.name && d.initializer && text(d.initializer) === want);
    });
    if (k < 0) continue;
    let n = 0;
    for (let j = k + 1; j < b.statements.length; j++) {
      const s = b.statements[j];
      if (stores(s)) {
        // A store to E or N ends the range; reads in its right side still see the old value.
        const st = storeOf(s);
        if (st && text(st.left) === want) n += replaceIn(st.right);
        break;
      }
      n += replaceIn(s);
    }
    if (n === 0) refuse(`no read of ${f.expr} after ${f.name}'s store`);
    return;
  }
  refuse(`${f.name} is never stored from ${f.expr}`);
}

function doOwn(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'own' }>): void {
  const newName = f.rename ?? f.name;
  const T = norm(f.type);
  let found = false;
  for (const b of blocks(fn)) {
    const k = b.statements.findIndex(s => declOf(s)?.name.name === f.name);
    if (k < 0) continue;
    const d = declOf(b.statements[k])!;
    if (d.initializer) {
      const init = unparen(d.initializer as Expression);
      const simple = (e: Expression): boolean => { e = unparen(e); return isId(e) || e.kind === NodeKind.IntegerLiteral || e.kind === NodeKind.NullptrLiteral || (e.kind === NodeKind.CStyleCastExpr && simple((e as CStyleCastExpr).expression)); };
      if (!simple(init)) refuse(`${f.name}'s initializer has effects`);
    }
    d.initializer = null;
    d.type = parseType(f.type);
    found = true;
    // The first statement after the declaration that names v: a plain store takes the declaration.
    const next = b.statements.findIndex((s, j) => j > k && mentions(s, f.name));
    if (next > k) {
      const st = storeOf(b.statements[next]);
      if (st && st.operator === '=' && isId(unparen(st.left), f.name) && !mentions(st.right, f.name)) {
        d.initializer = st.right;
        b.statements.splice(next, 1, b.statements[k]);
        b.statements.splice(k, 1);
      }
    }
    break;
  }
  if (!found) refuse(`no declaration of ${f.name}`);
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot || node.kind !== NodeKind.CStyleCastExpr) continue;
    const c = node as CStyleCastExpr;
    const inner = unparen(c.expression);
    const ct = text(c.type);
    if (isId(inner, f.name) && ct === T) put(slot, inner);
    // `T*`, or its Win32 spelling `LPT` (LPDWORD for DWORD*).
    else if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&' && isId(unparen((inner as UnaryExpr).operand), f.name) && (ct === T + '*' || ct === 'LP' + T)) put(slot, inner);
  }
  if (newName !== f.name) {
    if (localNames(fn).has(newName)) refuse(`${newName} exists`);
    for (const { node } of walk(fn.body!)) if (isId(node, f.name)) (node as Identifier).name = newName;
  }
}

function guardIfs(fn: FunctionDecl): IfStmt[] {
  const out: IfStmt[] = [];
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.IfStmt) continue;
    const s = node as IfStmt;
    if (!s.elseBranch && soleReturn(s.thenBranch)) out.push(s);
  }
  return out;
}

function doGuards(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'guards' }>): void {
  const cands: Array<{ s: IfStmt; parts: Expression[] }> = [];
  for (const s of guardIfs(fn)) {
    const c = unparen(s.condition);
    let parts: Expression[] | undefined;
    if (c.kind === NodeKind.UnaryExpr && (c as UnaryExpr).operator === '!') {
      const conj = chain((c as UnaryExpr).operand, '&&');
      if (conj.length > 1) parts = conj;
    } else {
      const disj = chain(c, '||');
      if (disj.length > 1) parts = disj.map(negate);
    }
    if (parts && parts.length > f.split) cands.push({ s, parts });
  }
  const hit = cands[f.index - 1] ?? refuse(`no guard #${f.index} of more than ${f.split} conditions`);
  for (const b of blocks(fn)) {
    const k = b.statements.indexOf(hit.s);
    if (k < 0) continue;
    const first: IfStmt = { ...hit.s, condition: join(hit.parts.slice(0, f.split).map(negate), '||'), thenBranch: cloneNode(hit.s.thenBranch) };
    const second: IfStmt = { ...hit.s, condition: join(hit.parts.slice(f.split).map(negate), '||'), thenBranch: cloneNode(hit.s.thenBranch) };
    b.statements.splice(k, 1, first, second);
    return;
  }
  refuse('the guard is not in a block');
}

function doMergeGuards(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'merge-guards' }>): void {
  let seen = 0;
  for (const b of blocks(fn)) {
    for (let i = 0; i + 1 < b.statements.length; i++) {
      const [x, y] = [b.statements[i], b.statements[i + 1]];
      if (x.kind !== NodeKind.IfStmt || y.kind !== NodeKind.IfStmt) continue;
      const [a, c] = [x as IfStmt, y as IfStmt];
      const ra = !a.elseBranch && soleReturn(a.thenBranch), rc = !c.elseBranch && soleReturn(c.thenBranch);
      if (!ra || !rc || text(ra) !== text(rc)) continue;
      if (++seen !== f.index) continue;
      b.statements.splice(i, 2, { ...a, condition: join([a.condition, c.condition], '||') });
      return;
    }
  }
  refuse(`no pair #${f.index} of adjacent guards returning one value`);
}

function doRetval(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'retval' }>): void {
  const parents = parentsOf(fn);
  const val = norm(f.value);
  for (const b of blocks(fn)) {
    const st = b.statements;
    const last = st[st.length - 1];
    const s = last && storeOf(last);
    if (!s || s.operator !== '=' || !isId(unparen(s.left), f.name) || text(s.right) !== val) continue;
    // Walk out while the construct ends here, to the statement whose next is `return V;`.
    let cur: ASTNode = b;
    for (;;) {
      const p = parents.get(cur);
      if (!p) break;
      if (p.kind === NodeKind.CompoundStmt) {
        const ps = (p as CompoundStmt).statements;
        const k = ps.indexOf(cur as Statement);
        const nx = ps[k + 1];
        if (nx && nx.kind === NodeKind.ReturnStmt && isId(unparen((nx as ReturnStmt).value as Expression), f.name)) {
          st[st.length - 1] = { kind: NodeKind.ReturnStmt, value: s.right } as unknown as ReturnStmt;
          return;
        }
        if (k !== ps.length - 1) break;
      } else if (![NodeKind.IfStmt, NodeKind.SwitchStmt, NodeKind.CaseStmt, NodeKind.DefaultStmt].includes(p.kind)) break;
      cur = p;
    }
  }
  refuse(`no ${f.name} = ${f.value} falling through to return ${f.name}`);
}

const WIDTH: Record<string, number> = {
  char: 1, bool: 1, int8_t: 1, uint8_t: 1, BYTE: 1, byte: 1, undefined1: 1, 'unsignedchar': 1, 'signedchar': 1,
  short: 2, 'shortint': 2, 'unsignedshort': 2, 'unsignedshortint': 2, int16_t: 2, uint16_t: 2, WORD: 2, ushort: 2, undefined2: 2, wchar_t: 2,
  int: 4, 'unsignedint': 4, unsigned: 4, uint: 4, int32_t: 4, uint32_t: 4, DWORD: 4, BOOL: 4, long: 4, 'unsignedlong': 4, ulong: 4, size_t: 4, undefined4: 4,
};

/** A value range; `u` marks an expression of a 32-bit unsigned type, whose arithmetic wraps. */
interface Range { lo: bigint; hi: bigint; u?: boolean }

const I32: Range = { lo: -0x80000000n, hi: 0x7fffffffn };
const U32: Range = { lo: 0n, hi: 0xffffffffn, u: true };
const RANGE: Record<string, Range> = {
  bool: { lo: 0n, hi: 1n },
  char: { lo: -0x80n, hi: 0x7fn }, 'signedchar': { lo: -0x80n, hi: 0x7fn }, int8_t: { lo: -0x80n, hi: 0x7fn },
  'unsignedchar': { lo: 0n, hi: 0xffn }, uint8_t: { lo: 0n, hi: 0xffn }, BYTE: { lo: 0n, hi: 0xffn }, byte: { lo: 0n, hi: 0xffn },
  undefined1: { lo: 0n, hi: 0xffn }, uchar: { lo: 0n, hi: 0xffn }, UCHAR: { lo: 0n, hi: 0xffn },
  short: { lo: -0x8000n, hi: 0x7fffn }, 'shortint': { lo: -0x8000n, hi: 0x7fffn }, 'signedshort': { lo: -0x8000n, hi: 0x7fffn },
  int16_t: { lo: -0x8000n, hi: 0x7fffn }, SHORT: { lo: -0x8000n, hi: 0x7fffn },
  'unsignedshort': { lo: 0n, hi: 0xffffn }, 'unsignedshortint': { lo: 0n, hi: 0xffffn }, uint16_t: { lo: 0n, hi: 0xffffn },
  WORD: { lo: 0n, hi: 0xffffn }, ushort: { lo: 0n, hi: 0xffffn }, undefined2: { lo: 0n, hi: 0xffffn }, wchar_t: { lo: 0n, hi: 0xffffn },
  USHORT: { lo: 0n, hi: 0xffffn },
  int: I32, 'signedint': I32, signed: I32, int32_t: I32, long: I32, 'longint': I32, BOOL: I32, INT: I32, LONG: I32,
  'unsignedint': U32, unsigned: U32, uint: U32, uint32_t: U32, DWORD: U32, 'unsignedlong': U32, 'unsignedlongint': U32,
  ulong: U32, ULONG: U32, UINT: U32, size_t: U32, undefined4: U32,
};

/**
 * The range and width of an integer type spelled t, through the typedef table. A spelling
 * that is no integer type is taken as an enum when `enumLike`: GCC gives an enum without
 * negative members `unsigned int`, one with them `int`, so only 0..INT_MAX is certain.
 */
function intType(t: string, enumLike: boolean): { r: Range; w: number; signUnknown?: boolean } | undefined {
  let b = norm(t).replace(/^const(?=\w)/, '');
  for (let k = 0; k < 8 && !RANGE[b]; k++) {
    const next = selectTables?.typedefTargets?.[b];
    if (!next) break;
    b = norm(next).replace(/^const(?=\w)/, '');
  }
  const r = RANGE[b];
  if (r) return { r, w: b === 'bool' ? 1 : WIDTH[b] ?? (r.hi > 0xffffn || r.lo < -0x8000n ? 4 : r.hi > 0xffn || r.lo < -0x80n ? 2 : 1) };
  if (!enumLike || /[*&\[]/.test(b)) return undefined;
  return { r: { lo: 0n, hi: 0x7fffffffn }, w: 4, signUnknown: true };
}

const within = (a: Range, b: Range) => a.lo >= b.lo && a.hi <= b.hi;
const bitsOf = (v: bigint) => { let n = 0; while (v > 0n) { v >>= 1n; n++; } return n; };

/** The values e can take, as far as its literals, casts and declared types tell; undefined when unknown. */
function rangeOf(e: Expression, shapeOf: ((x: Expression) => { base: string; stars: number } | null) | undefined): Range | undefined {
  e = unparen(e);
  switch (e.kind) {
    case NodeKind.IntegerLiteral: {
      const l = e as IntegerLiteralExpr;
      return { lo: l.value, hi: l.value, u: /u/i.test(l.suffix) || l.value > 0x7fffffffn };
    }
    case NodeKind.CharLiteral: { const v = BigInt((e as unknown as { value: number }).value); return { lo: v, hi: v }; }
    case NodeKind.BoolLiteral: { const v = (e as unknown as { value: boolean }).value ? 1n : 0n; return { lo: v, hi: v }; }
    case NodeKind.CStyleCastExpr: {
      const c = e as CStyleCastExpr;
      const t = intType(text(c.type), false);
      if (!t) return undefined;
      if (text(c.type) === 'bool') return { lo: 0n, hi: 1n };
      const inner = rangeOf(c.expression, shapeOf);
      return inner && within(inner, t.r) ? { ...inner, u: t.r.u } : t.r;
    }
    case NodeKind.ConditionalExpr: {
      const c = e as ConditionalExpr;
      const a = rangeOf(c.thenExpr, shapeOf), b = rangeOf(c.elseExpr, shapeOf);
      return a && b ? { lo: a.lo < b.lo ? a.lo : b.lo, hi: a.hi > b.hi ? a.hi : b.hi, u: a.u || b.u } : undefined;
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator === '!') return { lo: 0n, hi: 1n };
      if (u.operator === '-') {
        const a = rangeOf(u.operand, shapeOf);
        if (!a || a.u) return undefined;
        const r = { lo: -a.hi, hi: -a.lo };
        return within(r, I32) ? r : undefined;
      }
      break;
    }
    case NodeKind.BinaryExpr: {
      const x = e as BinaryExpr;
      if (['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(x.operator)) return { lo: 0n, hi: 1n };
      const a = rangeOf(x.left, shapeOf), b = rangeOf(x.right, shapeOf);
      const u = !!(a?.u || b?.u);
      const fit = (r: Range): Range | undefined => (u ? (r.lo >= 0n && r.hi <= 0xffffffffn ? { ...r, u } : undefined) : within(r, I32) ? r : undefined);
      if (x.operator === '&') {
        // Masking by a non-negative value bounds the result by it, whatever the other side.
        const ks = [a, b].filter((r): r is Range => !!r && r.lo >= 0n);
        if (ks.length) return { lo: 0n, hi: ks.reduce((m, r) => (r.hi < m ? r.hi : m), ks[0].hi), u };
        return undefined;
      }
      if (!a || !b) return undefined;
      switch (x.operator) {
        case '+': return fit({ lo: a.lo + b.lo, hi: a.hi + b.hi });
        case '-': return fit({ lo: a.lo - b.hi, hi: a.hi - b.lo });
        case '*': {
          const p = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
          return fit({ lo: p.reduce((m, v) => (v < m ? v : m)), hi: p.reduce((m, v) => (v > m ? v : m)) });
        }
        case '|': case '^':
          return a.lo >= 0n && b.lo >= 0n ? { lo: 0n, hi: (1n << BigInt(bitsOf(a.hi > b.hi ? a.hi : b.hi))) - 1n, u } : undefined;
        case '%':
          if (b.lo !== b.hi || b.lo <= 0n) return undefined;
          return a.lo >= 0n ? { lo: 0n, hi: b.lo - 1n, u } : u ? undefined : { lo: 1n - b.lo, hi: b.lo - 1n };
        case '>>':
          if (b.lo !== b.hi || b.lo < 0n || b.lo > 31n || a.lo < 0n) return undefined;
          return { lo: a.lo >> b.lo, hi: a.hi >> b.lo, u };
        case '/':
          if (b.lo !== b.hi || b.lo <= 0n || a.lo < 0n) return undefined;
          return { lo: a.lo / b.lo, hi: a.hi / b.lo, u };
      }
      return undefined;
    }
  }
  const s = shapeOf?.(e);
  if (!s || s.stars !== 0) return undefined;
  return intType(s.base, false)?.r;
}

/**
 * width(V,T): V is declared T. Value-preserving, or refused: every value stored into V
 * must lie in both its old type and T, so V holds the same number either way; or every
 * read of V must keep no more of it than the narrower of the two types holds (a cast to a
 * type that wide, a mask, a parameter or return of that width): both keep the stored
 * value's low bytes, so such a read sees the same value. A read of all of a wider V, after
 * a store the old type truncated, is refused (OBJECT_DispatchShrineServerActivate 004bd5c0
 * widens a char code read as `(uint32_t)V`).
 */
function doWidth(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'width' }>): void {
  let d: VariableDecl | undefined;
  for (const b of blocks(fn)) { for (const s of b.statements) { const x = declOf(s); if (x?.name.name === f.name) d = x; } }
  if (!d) refuse(`no declaration of ${f.name}`);
  const old = text(d!.type), T = norm(f.type);
  if (old === T) refuse(`${f.name} is ${f.type} already`);
  const w = WIDTH[T];
  const oldT = intType(old, true), newT = intType(T, true);
  if (!oldT || !newT) refuse(`${!oldT ? old : T} is no integer type`);
  // Through its address V is bytes; between two types of one width those bytes are the
  // same, as long as each `&V` is cast to the pointer it is used as, so the pointer's type
  // never follows V's (SUNITNPC_ApplyScrollSkill 00576e40 stores `*(uint8_t*)(char*)&eUnitType`).
  if (addressTaken(fn, f.name) && (oldT!.w !== newT!.w || !addressOnlyCast(fn, f.name))) refuse(`&${f.name} is taken`);
  const truth = new Set<ASTNode>();
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.IfStmt || node.kind === NodeKind.WhileStmt || node.kind === NodeKind.DoWhileStmt) truth.add(unparen((node as IfStmt).condition));
    if (node.kind === NodeKind.ForStmt && (node as unknown as { condition: Expression | null }).condition) truth.add(unparen((node as unknown as { condition: Expression }).condition));
    if (node.kind === NodeKind.ConditionalExpr) truth.add(unparen((node as ConditionalExpr).condition));
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '!') truth.add(unparen((node as UnaryExpr).operand));
    if (node.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((node as BinaryExpr).operator)) { truth.add(unparen((node as BinaryExpr).left)); truth.add(unparen((node as BinaryExpr).right)); }
  }
  checkWidthPreserved(fn, f.name, d!, oldT!, newT!, old, T, truth);
  d!.type = parseType(f.type);
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot) continue;
    if (node.kind === NodeKind.CStyleCastExpr) {
      const c = node as CStyleCastExpr; const inner = unparen(c.expression); const ct = text(c.type);
      if (isId(inner, f.name) && (ct === T || (truth.has(node) && w !== undefined && WIDTH[ct] === w))) put(slot, inner);
    }
    if (node.kind === NodeKind.AssignExpr && isId(unparen((node as AssignExpr).left), f.name)) {
      const r = unparen((node as AssignExpr).right);
      if (r.kind === NodeKind.CStyleCastExpr && text((r as CStyleCastExpr).type) === old) (node as AssignExpr).right = (r as CStyleCastExpr).expression;
    }
  }
}

type IntInfo = { r: Range; w: number; signUnknown?: boolean };

function checkWidthPreserved(fn: FunctionDecl, v: string, d: VariableDecl, oldT: IntInfo, newT: IntInfo,
  old: string, T: string, truth: Set<ASTNode>): void {
  const parents = parentsOf(fn);
  const tables = selectTables;
  const shapeOf = tables ? createExprShape(localTypesOf(fn), {
    globalTypes: tables.globalTypes ?? {}, enclosingVarTypes: tables.enclosingVarTypes ?? {},
    structFields: tables.structFields ?? {}, fieldTypes: tables.fieldTypes ?? {},
    returnTypes: tables.functionReturnTypes ?? {}, resolve: (n: string) => tables.typedefTargets?.[n],
  }) : (x: Expression) => {
    const id = unparen(x);
    if (!isId(id)) return null;
    for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.VariableDecl && (node as VariableDecl).name.name === id.name) return { base: text((node as VariableDecl).type), stars: 0 };
    for (const p of fn.parameters) if ((p as unknown as { name?: Identifier | null }).name?.name === id.name) return { base: text(p.type), stars: 0 };
    return null;
  };
  const both: Range = { lo: oldT.r.lo > newT.r.lo ? oldT.r.lo : newT.r.lo, hi: oldT.r.hi < newT.r.hi ? oldT.r.hi : newT.r.hi };

  // The stores, each with the value it stores once the form has dropped a cast to the old type.
  const stored: Array<{ what: string; value?: Expression }> = [];
  if (d.initializer && d.initializer.kind !== NodeKind.InitListExpr) stored.push({ what: `${v} = ${emit(d.initializer as never)}`, value: d.initializer as Expression });
  const storeNodes = new Set<ASTNode>([d.name]);
  // `&V` reads no value: doWidth lets it through only where the bytes stay the same.
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && isId(unparen((node as UnaryExpr).operand), v)) storeNodes.add(unparen((node as UnaryExpr).operand));
  }
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.AssignExpr && isId(unparen((node as AssignExpr).left), v)) {
      const a = node as AssignExpr;
      storeNodes.add(unparen(a.left));
      let r = unparen(a.right);
      if (r.kind === NodeKind.CStyleCastExpr && text((r as CStyleCastExpr).type) === old) r = (r as CStyleCastExpr).expression;
      stored.push(a.operator === '=' ? { what: emit(a as never), value: r } : { what: emit(a as never) });
    }
    if ((node.kind === NodeKind.PostfixExpr || (node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator)))
      && isId(unparen((node as UnaryExpr).operand), v)) {
      storeNodes.add(unparen((node as UnaryExpr).operand));
      stored.push({ what: emit(node as never) });
    }
  }
  const outOfRange = stored.filter(s => {
    if (!s.value) return true;
    const r = rangeOf(s.value, shapeOf);
    return !r || !within(r, both);
  });

  if (outOfRange.length === 0) {
    // Every value is the same number in either type. A read still means the same only
    // where its operation does not depend on the signedness of a 32-bit V.
    const sign32 = (t: IntInfo) => (t.signUnknown ? 'unknown' : t.w === 4 ? (t.r.u ? 'u' : 's') : 's');
    if (sign32(oldT) === sign32(newT) && sign32(oldT) !== 'unknown') return;
    for (const { node } of walk(fn.body!)) {
      if (!isId(node, v) || storeNodes.has(node)) continue;
      const why = signSensitiveRead(node, parents, truth, shapeOf);
      if (why) refuse(`${v} changes signedness (${old} -> ${T}) and ${why}`);
    }
    return;
  }

  // The second way: no read keeps more of V than both types hold. V = E then keeps E's low
  // bytes in either type (the old one truncates at the store, a wider T at the read), so a
  // read of no more than those low bytes sees the same value: MISSILE_SetPathFromTotalFrames
  // (004cccc0) stores the frame count into an int and passes it as a uint8_t, where the
  // tagless source truncates at the store; the original keeps the whole count in EBX.
  const keep = Math.min(oldT.w, newT.w);
  const why = (s: string) => `${outOfRange[0].what} can exceed ${both.lo === oldT.r.lo && both.hi === oldT.r.hi ? old : T} and ${s}`;
  // A compound store keeps the low bytes only where it works on them alone.
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.AssignExpr && isId(unparen((node as AssignExpr).left), v)
      && !['=', '+=', '-=', '*=', '&=', '|=', '^=', '<<='].includes((node as AssignExpr).operator)) {
      refuse(why(`${emit(node as never)} reads more than the low bytes`));
    }
  }
  for (const { node } of walk(fn.body!)) {
    if (!isId(node, v) || storeNodes.has(node)) continue;
    const kept = readWidth(fn, node, parents, oldT.w === newT.w ? both : undefined);
    if (kept === undefined || kept > keep) refuse(why(`the read in ${emit((parents.get(node) ?? node) as never)} keeps ${kept === undefined ? 'all of it' : `${kept * 8} bits`}`));
  }
}

/** How many bytes of V a read keeps: a cast to an integer type, a mask, a parameter or the return of that width. */
function readWidth(fn: FunctionDecl, id: ASTNode, parents: Map<ASTNode, ASTNode>, both?: Range): number | undefined {
  let cur: ASTNode = id;
  let p = parents.get(cur);
  while (p && p.kind === NodeKind.ParenExpr) { cur = p; p = parents.get(cur); }
  if (!p) return undefined;
  // Between two types of one width, equality with a constant both hold tells the same
  // values apart (INPUT_ConfigMouseButtonHandler switches a short on 1 and 2 as a WORD).
  const constIn = (e: Expression) => { const r = both && rangeOf(e, undefined); return !!r && r.lo === r.hi && within(r, both!); };
  if (p.kind === NodeKind.BinaryExpr && ['==', '!='].includes((p as BinaryExpr).operator)) {
    const x = p as BinaryExpr;
    return constIn(x.left === cur ? x.right : x.left) ? 1 : undefined;
  }
  if (p.kind === NodeKind.SwitchStmt && (p as unknown as { condition: ASTNode }).condition === cur) {
    const labels: Expression[] = [];
    for (const { node } of walk((p as unknown as { body: ASTNode }).body)) {
      if (node.kind === NodeKind.SwitchStmt) return undefined;
      if (node.kind === NodeKind.CaseStmt) labels.push((node as unknown as { value: Expression }).value);
    }
    return labels.every(constIn) ? 1 : undefined;
  }
  const narrow = (t: string) => (norm(t) === 'bool' ? undefined : intType(t, false)?.w);
  if (p.kind === NodeKind.CStyleCastExpr) return narrow(text((p as CStyleCastExpr).type));
  if (p.kind === NodeKind.BinaryExpr && (p as BinaryExpr).operator === '&') {
    const x = p as BinaryExpr;
    const k = unparen(x.left === cur ? x.right : x.left);
    if (k.kind !== NodeKind.IntegerLiteral) return undefined;
    const bits = bitsOf((k as IntegerLiteralExpr).value);
    return bits <= 8 ? 1 : bits <= 16 ? 2 : 4;
  }
  if (p.kind === NodeKind.CallExpr && (p as unknown as { arguments: ASTNode[] }).arguments.includes(cur)) {
    const call = p as unknown as { callee: Expression; arguments: ASTNode[] };
    const name = calleeName(call.callee);
    const params = name && selectTables?.functionParamTypes
      ? scopedLookup(selectTables.functionParamTypes, name, selectTables.enclosingSegments ?? []) : undefined;
    const t = params?.[call.arguments.indexOf(cur)];
    return t ? narrow(t) : undefined;
  }
  if (p.kind === NodeKind.ReturnStmt) return narrow(text(fn.returnType));
  return undefined;
}

/**
 * Why a read of V, an in-range value, means something else once V's 32-bit signedness
 * changes; undefined when it does not. + - * & | ^ << ~ wrap the same in either; a
 * comparison, / % >> or an index do not, unless the value is still V itself and the other
 * operand a non-negative value.
 */
function signSensitiveRead(id: ASTNode, parents: Map<ASTNode, ASTNode>, truth: Set<ASTNode>,
  shapeOf: (x: Expression) => { base: string; stars: number } | null): string | undefined {
  let cur: ASTNode = id;
  let mixed = false;
  const nonneg = (e: Expression) => { const r = rangeOf(e, shapeOf); return !!r && r.lo >= 0n && r.hi <= 0x7fffffffn; };
  for (;;) {
    if (truth.has(cur)) return undefined;
    const p = parents.get(cur);
    if (!p) return undefined;
    switch (p.kind) {
      case NodeKind.ParenExpr: cur = p; continue;
      case NodeKind.CStyleCastExpr: return undefined;
      case NodeKind.UnaryExpr:
        if (['-', '~'].includes((p as UnaryExpr).operator)) { mixed = true; cur = p; continue; }
        if ((p as UnaryExpr).operator === '!') return undefined;
        return `${emit(p as never)} reads it`;
      case NodeKind.BinaryExpr: {
        const x = p as BinaryExpr;
        const other = x.left === cur ? x.right : x.left;
        if (['+', '-', '*', '&', '|', '^'].includes(x.operator) || (x.operator === '<<' && x.left === cur)) { mixed = true; cur = p; continue; }
        if (['==', '!=', '<', '<=', '>', '>=', '/', '%', '>>'].includes(x.operator)) {
          if (!mixed && nonneg(other) && (!['/', '%', '>>'].includes(x.operator) || x.left === cur)) {
            if (['/', '%', '>>'].includes(x.operator)) { cur = p; continue; }
            return undefined;
          }
          return `${emit(p as never)} depends on it`;
        }
        if (['&&', '||'].includes(x.operator)) return undefined;
        return `${emit(p as never)} reads it`;
      }
      case NodeKind.SubscriptExpr: return mixed ? `the index ${emit(p as never)} depends on it` : undefined;
      default: return undefined;
    }
  }
}

/** The one declaration of local V in fn's body, refusing a parameter-free miss, a second one or a static. */
function soleDecl(fn: FunctionDecl, name: string): VariableDecl {
  let d: VariableDecl | undefined;
  let n = 0;
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.VariableDecl && (node as VariableDecl).name.name === name) { d = node as VariableDecl; n++; }
  if (!d) refuse(`no declaration of ${name}`);
  if (n > 1) refuse(`${name} is declared ${n} times`);
  if (d!.specifiers.length > 0) refuse(`${name} is ${d!.specifiers.join(' ')}`);
  if (d!.initializer && d!.initializer.kind === NodeKind.InitListExpr) refuse(`${name} has a brace initializer`);
  return d!;
}

/** Each mention of V that is not its declaration's name, with the node that holds it (parentheses skipped). */
function mentionSites(fn: FunctionDecl, name: string): Array<{ id: Identifier; holder: ASTNode | undefined; child: ASTNode }> {
  const parents = parentsOf(fn);
  const out: Array<{ id: Identifier; holder: ASTNode | undefined; child: ASTNode }> = [];
  for (const { node } of walk(fn.body!)) {
    if (!isId(node, name)) continue;
    let child: ASTNode = node;
    let p = parents.get(child);
    if (p && p.kind === NodeKind.VariableDecl && (p as VariableDecl).name === node) continue;
    while (p && p.kind === NodeKind.ParenExpr) { child = p; p = parents.get(p); }
    out.push({ id: node as Identifier, holder: p, child });
  }
  return out;
}

/** Refuses when V's address or size is taken, it is modified in place, or it sits in a brace initializer. */
function refusePinned(fn: FunctionDecl, name: string): void {
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.SizeofExpr && [...walk(node)].some(x => isId(x.node, name))) refuse(`the size of ${name} is taken`);
    if (node.kind === NodeKind.InitListExpr && [...walk(node)].some(x => isId(x.node, name))) refuse(`${name} is in a brace initializer`);
    if ((node.kind === NodeKind.UnaryExpr || node.kind === NodeKind.PostfixExpr) && ['&', '++', '--'].includes((node as UnaryExpr).operator)
      && isId(unparen((node as UnaryExpr).operand), name)) refuse(`${name} is ${(node as UnaryExpr).operator === '&' ? 'addressed' : 'stepped'}`);
    if (node.kind === NodeKind.AssignExpr && (node as AssignExpr).operator !== '=' && isId(unparen((node as AssignExpr).left), name)) refuse(`${name} is compound-assigned`);
  }
}

function doBoolflag(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'boolflag' }>): void {
  const d = soleDecl(fn, f.name);
  if (text(d.type) !== 'bool') refuse(`${f.name} is not a bool`);
  refusePinned(fn, f.name);
  const literals: ASTNode[] = [];
  const literal = (e: Expression) => {
    const u = unparen(e);
    if (u.kind !== NodeKind.BoolLiteral) refuse(`${f.name} is stored ${text(e)}`);
    literals.push(u);
  };
  if (d.initializer) literal(d.initializer as Expression);
  let reads = 0;
  for (const m of mentionSites(fn, f.name)) {
    const p = m.holder as (ASTNode & { condition?: ASTNode; operator?: string; left?: ASTNode; right?: Expression }) | undefined;
    if (p && p.kind === NodeKind.AssignExpr && p.left === m.child) { literal(p.right!); continue; }
    reads++;
    const ok = !!p && (
      ([NodeKind.IfStmt, NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt, NodeKind.ConditionalExpr] as string[]).includes(p.kind) && p.condition === m.child
      || p.kind === NodeKind.UnaryExpr && p.operator === '!'
      || p.kind === NodeKind.BinaryExpr && (p.operator === '&&' || p.operator === '||'));
    if (!ok) refuse(`${f.name} is read as a value`);
  }
  if (reads === 0) refuse(`${f.name} is never read`);
  d.type = parseType('BOOL');
  for (const l of literals) {
    const b = l as unknown as Record<string, unknown>;
    const v = b.value ? 1n : 0n;
    delete b.value;
    Object.assign(b, { kind: NodeKind.IntegerLiteral, value: v, raw: v.toString(), base: 10, suffix: '' });
  }
}

function doRetwiden(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'retwiden' }>): void {
  const d = soleDecl(fn, f.name);
  const old = text(d.type);
  const w = WIDTH[old];
  if (w !== 1 && w !== 2 || old === 'bool') refuse(`${f.name} is ${old}, not a one- or two-byte integer`);
  refusePinned(fn, f.name);
  const stores: Array<{ get: () => Expression; set: (e: Expression) => void }> = [];
  if (d.initializer) stores.push({ get: () => d.initializer as Expression, set: e => { d.initializer = e; } });
  for (const m of mentionSites(fn, f.name)) {
    const a = m.holder as AssignExpr | undefined;
    if (a && a.kind === NodeKind.AssignExpr && a.left === m.child) stores.push({ get: () => a.right, set: e => { a.right = e; } });
  }
  if (!stores.some(s => unparen(s.get()).kind === NodeKind.CallExpr)) refuse(`${f.name} is stored from no call`);
  const T = d.type;
  for (const s of stores) {
    const e = unparen(s.get());
    if (e.kind === NodeKind.CStyleCastExpr && text((e as CStyleCastExpr).type) === old) continue;
    s.set({ kind: NodeKind.CStyleCastExpr, type: cloneNode(T), expression: { kind: NodeKind.ParenExpr, expression: s.get() } } as unknown as Expression);
  }
  d.type = parseType('int32_t');
}

function doArms(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'arms' }>): void {
  const want = norm(f.cond);
  let seen = 0;
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.IfStmt) continue;
    const s = node as IfStmt;
    if (!s.elseBranch || text(s.condition) !== want) continue;
    if (f.index && ++seen !== f.index) continue;
    if (s.elseBranch.kind === NodeKind.IfStmt) refuse('the else arm is an else-if chain');
    const t = s.thenBranch;
    s.condition = f.wrap ? negateWrap(s.condition) : negate(s.condition);
    s.thenBranch = s.elseBranch;
    s.elseBranch = t;
    return;
  }
  refuse(f.index ? `no if/else #${f.index} on ${f.cond}` : `no if/else on ${f.cond}`);
}

// ---------------------------------------------------------------------------------------
// Control-flow and expression forms

const asBlock = (s: Statement): CompoundStmt =>
  s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt) : ({ kind: NodeKind.CompoundStmt, statements: [s] } as unknown as CompoundStmt);

const stmtsOf = (s: Statement): Statement[] => (s.kind === NodeKind.CompoundStmt ? (s as CompoundStmt).statements : [s]);

const JUMPS = new Set<string>([NodeKind.ReturnStmt, NodeKind.BreakStmt, NodeKind.ContinueStmt, NodeKind.GotoStmt]);

/** A call to exit or abort, which never returns. */
function noReturnCall(s: Statement): boolean {
  if (s.kind !== NodeKind.ExprStmt) return false;
  const e = unparen((s as ExprStmt).expression);
  if (e.kind !== NodeKind.CallExpr) return false;
  const c = unparen((e as unknown as { callee: Expression }).callee);
  return isId(c) && ['exit', 'abort', '_exit'].includes(c.name);
}

/** Whether a statement always leaves: it ends in a jump, exit() or abort(), a block that leaves, or an if/else whose arms both leave. */
function leaves(s: Statement): boolean {
  const st = stmtsOf(s);
  const last = st[st.length - 1];
  if (!last) return false;
  if (JUMPS.has(last.kind)) return true;
  if (noReturnCall(last)) return true;
  if (last.kind === NodeKind.CompoundStmt) return leaves(last);
  if (last.kind === NodeKind.IfStmt) { const x = last as IfStmt; return !!x.elseBranch && leaves(x.thenBranch) && leaves(x.elseBranch); }
  return false;
}

/** The direct child nodes of n. */
function childrenOf(n: ASTNode): ASTNode[] {
  const out: ASTNode[] = [];
  for (const key of Object.keys(n)) {
    if (key === 'location' || key === 'leadingTrivia' || key === 'trailingTrivia') continue;
    const v = (n as unknown as Record<string, unknown>)[key];
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && typeof (x as ASTNode).kind === 'string') out.push(x as ASTNode); }
    else if (v && typeof v === 'object' && typeof (v as ASTNode).kind === 'string') out.push(v as ASTNode);
  }
  return out;
}

/**
 * Labels and declarations at the top of a statement list cannot move into a new scope. The
 * case and default labels of a switch that moves whole move with it (OBJOP_A5Q5_
 * WorldstonePortalActivate 0058d400 ends in one); a goto label still refuses.
 */
function movable(st: Statement[], declsOk: boolean): string | undefined {
  const labelIn = (n: ASTNode, inSwitch: boolean): boolean => {
    if (n.kind === NodeKind.LabelStmt) return true;
    if (!inSwitch && (n.kind === NodeKind.CaseStmt || n.kind === NodeKind.DefaultStmt)) return true;
    const inner = inSwitch || n.kind === NodeKind.SwitchStmt;
    return childrenOf(n).some(c => labelIn(c, inner));
  };
  for (const s of st) {
    if (labelIn(s, false)) return 'a label would move';
    if (!declsOk && s.kind === NodeKind.DeclStmt) return 'a declaration would change scope';
  }
  return undefined;
}

/** The i-th (1-based) `if` with no else on condition `want`, with its block and index. */
function nthIf(fn: FunctionDecl, want: string, index: number): { b: CompoundStmt; k: number; s: IfStmt } {
  const w = norm(want);
  let seen = 0;
  for (const b of blocks(fn)) {
    for (let k = 0; k < b.statements.length; k++) {
      const s = b.statements[k];
      if (s.kind !== NodeKind.IfStmt) continue;
      const x = s as IfStmt;
      if (x.elseBranch || x.init || text(x.condition) !== w) continue;
      if (++seen === index) return { b, k, s: x };
    }
  }
  return refuse(`no if #${index} on ${want} without an else`);
}

function doNest(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'nest' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (!leaves(s.thenBranch)) refuse('the guard does not always leave');
  const rest = b.statements.slice(k + 1);
  if (rest.length === 0) refuse('nothing follows the guard');
  const why = movable(rest, true);
  if (why) refuse(why);
  const then = { kind: NodeKind.CompoundStmt, statements: rest } as unknown as CompoundStmt;
  b.statements.splice(k, rest.length + 1, { ...s, condition: negateWrap(s.condition), thenBranch: then, elseBranch: asBlock(s.thenBranch) } as IfStmt);
}

function doMergeTail(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'merge-tail' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  const arm = stmtsOf(s.thenBranch);
  const last = arm[arm.length - 1];
  if (!last || last.kind !== NodeKind.ReturnStmt) refuse('the arm does not end in a return');
  const ret = text(last);
  if (arm.length === 1) {
    // The guard: the block ends in the same return.
    const tail = b.statements[b.statements.length - 1];
    if (b.statements.length - 1 <= k || !tail || tail.kind !== NodeKind.ReturnStmt || text(tail) !== ret) refuse('the block does not end in the guard\'s return');
    const between = b.statements.slice(k + 1, b.statements.length - 1);
    if (between.length === 0) refuse('nothing between the guard and the return');
    const why = movable(between, true);
    if (why) refuse(why);
    if (between.some(x => x.kind === NodeKind.DeclStmt && mentions(tail, (declOf(x)?.name.name) ?? '\u0000'))) refuse('the return reads a declaration that would move');
    const then = { kind: NodeKind.CompoundStmt, statements: between } as unknown as CompoundStmt;
    b.statements.splice(k, between.length + 1, { ...s, condition: negateWrap(s.condition), thenBranch: then } as IfStmt);
    return;
  }
  // The arm: the if falls through to the same return, or the block ends in it after other
  // statements, which become the else arm.
  const next = b.statements[k + 1];
  if (next && next.kind === NodeKind.ReturnStmt && text(next) === ret) { arm.pop(); return; }
  const tail = b.statements[b.statements.length - 1];
  if (b.statements.length - 1 <= k + 1 || tail.kind !== NodeKind.ReturnStmt || text(tail) !== ret) refuse('the if does not fall through to the same return');
  const between = b.statements.slice(k + 1, b.statements.length - 1);
  const why = movable(between, true);
  if (why) refuse(why);
  if (between.some(x => x.kind === NodeKind.DeclStmt && mentions(tail, (declOf(x)?.name.name) ?? '\u0000'))) refuse('the return reads a declaration that would move');
  arm.pop();
  s.thenBranch = asBlock(s.thenBranch);
  (s.thenBranch as CompoundStmt).statements = arm;
  s.elseBranch = { kind: NodeKind.CompoundStmt, statements: between } as unknown as CompoundStmt;
  b.statements.splice(k + 1, between.length);
}

function doContinue(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'continue' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (k !== b.statements.length - 1) refuse('the if does not end its block');
  const parents = parentsOf(fn);
  const owner = parents.get(b);
  if (!owner || ![NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt].includes(owner.kind) || (owner as unknown as { body: ASTNode }).body !== b) refuse('the block is no loop body');
  const arm = stmtsOf(s.thenBranch);
  const why = movable(arm, false);
  if (why) refuse(why);
  const cont = { kind: NodeKind.CompoundStmt, statements: [{ kind: NodeKind.ContinueStmt } as unknown as Statement] } as unknown as CompoundStmt;
  b.statements.splice(k, 1, { ...s, condition: negateWrap(s.condition), thenBranch: cont } as IfStmt, ...arm);
}

function doDecl(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'decl' }>): void {
  for (const b of blocks(fn)) {
    const from = b.statements.findIndex(s => declOf(s)?.name.name === f.name);
    const to = b.statements.findIndex(s => declOf(s)?.name.name === f.before);
    if (from < 0 || to < 0) continue;
    const d = declOf(b.statements[from])!;
    if (d.initializer) refuse(`${f.name} is initialized`);
    if (from === to - 1) refuse(`${f.name} is before ${f.before} already`);
    const past = from < to ? b.statements.slice(from + 1, to) : b.statements.slice(to, from);
    if (past.some(s => mentions(s, f.name))) refuse(`${f.name} is named by a statement it moves past`);
    // Its type must not name what it moves above.
    if (from > to && past.some(s => { const x = declOf(s); return !!x && mentions(d.type as unknown as ASTNode, x.name.name); })) refuse(`${f.name}'s type names a declaration it moves past`);
    const [s] = b.statements.splice(from, 1);
    b.statements.splice(from < to ? to - 1 : to, 0, s);
    return;
  }
  refuse(`no block declares both ${f.name} and ${f.before}`);
}

function doSelect(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'select' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  const a = soleReturn(s.thenBranch);
  const next = b.statements[k + 1];
  if (!a || !a.value) refuse('the guard is no `return A;`');
  if (k + 1 !== b.statements.length - 1 || next.kind !== NodeKind.ReturnStmt || !(next as ReturnStmt).value) refuse('the guard is not followed by the block\'s last `return B;`');
  const sel = { kind: NodeKind.ConditionalExpr, condition: s.condition, thenExpr: a!.value, elseExpr: (next as ReturnStmt).value } as unknown as ConditionalExpr;
  b.statements.splice(k, 2, { kind: NodeKind.ReturnStmt, value: sel } as unknown as ReturnStmt);
}

function doUnselect(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'unselect' }>): void {
  const w = norm(f.cond);
  const hits: Array<{ b: CompoundStmt; k: number; c: ConditionalExpr }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    if (s.kind !== NodeKind.ReturnStmt || !(s as ReturnStmt).value) return;
    const v = unparen((s as ReturnStmt).value!);
    if (v.kind === NodeKind.ConditionalExpr && text((v as ConditionalExpr).condition) === w) hits.push({ b, k, c: v as ConditionalExpr });
  });
  const hit = f.index === 0 ? (hits.length === 1 ? hits[0] : refuse(`${hits.length} returns select on ${f.cond}`)) : (hits[f.index - 1] ?? refuse(`no return #${f.index} selects on ${f.cond}`));
  const ret = (v: Expression) => ({ kind: NodeKind.ReturnStmt, value: v }) as unknown as ReturnStmt;
  const guard = { kind: NodeKind.IfStmt, condition: hit.c.condition, thenBranch: { kind: NodeKind.CompoundStmt, statements: [ret(hit.c.thenExpr)] }, elseBranch: null, isConstexpr: false } as unknown as IfStmt;
  hit.b.statements.splice(hit.k, 1, guard, ret(hit.c.elseExpr));
}

function doDup(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'dup' }>): void {
  const w = norm(f.stmt).replace(/;$/, '');
  const hits: Array<{ b: CompoundStmt; k: number }> = [];
  for (const b of blocks(fn)) {
    for (let k = 1; k < b.statements.length; k++) {
      const s = b.statements[k];
      if (s.kind === NodeKind.ExprStmt && text((s as ExprStmt).expression) === w && b.statements[k - 1].kind === NodeKind.IfStmt) hits.push({ b, k });
    }
  }
  if (hits.length !== 1) refuse(`${hits.length} statements ${f.stmt} after an if`);
  const { b, k } = hits[0];
  const arms: Array<{ holder: IfStmt; key: 'thenBranch' | 'elseBranch' }> = [];
  let cur = b.statements[k - 1] as IfStmt;
  for (;;) {
    if (cur.init) refuse('an if with an init statement');
    arms.push({ holder: cur, key: 'thenBranch' });
    if (!cur.elseBranch) refuse('the if has no final else');
    if (cur.elseBranch.kind === NodeKind.IfStmt) { cur = cur.elseBranch as IfStmt; continue; }
    arms.push({ holder: cur, key: 'elseBranch' });
    break;
  }
  const s = b.statements[k];
  // S lands at the end of each arm: an arm that ends in a jump would never reach it, and a
  // name the arm declares would capture one S reads.
  for (const a of arms) {
    const st = stmtsOf(a.holder[a.key]!);
    if (st.length > 0 && JUMPS.has(st[st.length - 1].kind)) refuse('an arm ends in a jump');
    for (const x of st) {
      if (x.kind !== NodeKind.DeclStmt) continue;
      for (const d of (x as DeclStmt).declarations) {
        const n = (d as unknown as { name?: Identifier }).name;
        if (!n || mentions(s, n.name)) refuse(`an arm declares ${n?.name ?? 'a name'} S reads`);
      }
    }
  }
  for (const a of arms) {
    const blk = asBlock(a.holder[a.key]!);
    blk.statements.push(cloneNode(s));
    a.holder[a.key] = blk;
  }
  b.statements.splice(k, 1);
}

/**
 * True when evaluating e earlier, and whether or not a test that stores nothing holds,
 * gives the same value and cannot fault: locals, parameters, globals, literals, casts,
 * arithmetic without division, and the address of an lvalue whose address loads nothing
 * (`&p->m.n`, not `&p->m->n` or `&a[i]`).
 */
function loadsNothing(e: Expression): boolean {
  e = unparen(e);
  switch (e.kind) {
    case NodeKind.Identifier: case NodeKind.QualifiedId:
    case NodeKind.IntegerLiteral: case NodeKind.FloatingLiteral: case NodeKind.CharLiteral:
    case NodeKind.StringLiteral: case NodeKind.BoolLiteral: case NodeKind.NullptrLiteral:
      return true;
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr: case NodeKind.ConstCastExpr:
      return loadsNothing((e as CStyleCastExpr).expression);
    case NodeKind.BinaryExpr: {
      const b = e as BinaryExpr;
      if (['/', '%'].includes(b.operator)) return false;
      return loadsNothing(b.left) && loadsNothing(b.right);
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      if (u.operator === '&') return addressLoadsNothing(u.operand);
      return ['-', '+', '~', '!'].includes(u.operator) && loadsNothing(u.operand);
    }
  }
  return false;
}

function addressLoadsNothing(lv: Expression): boolean {
  lv = unparen(lv);
  if (lv.kind === NodeKind.Identifier || lv.kind === NodeKind.QualifiedId) return true;
  if (lv.kind === NodeKind.MemberExpr) {
    const m = lv as unknown as { object: Expression; isArrow: boolean };
    return m.isArrow ? loadsNothing(m.object) : addressLoadsNothing(m.object);
  }
  return false;
}

function doHoist(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'hoist' }>): void {
  const w = norm(f.stmt).replace(/;$/, '');
  const hits: Array<{ b: CompoundStmt; k: number }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    if (s.kind !== NodeKind.IfStmt) return;
    const arm = stmtsOf((s as IfStmt).thenBranch);
    if (arm.length > 0 && arm[0].kind === NodeKind.ExprStmt && text((arm[0] as ExprStmt).expression) === w) hits.push({ b, k });
  });
  const hit = f.index === 0 ? (hits.length === 1 ? hits[0] : refuse(`${hits.length} ifs begin with ${f.stmt}`)) : (hits[f.index - 1] ?? refuse(`no if #${f.index} begins with ${f.stmt}`));
  const ifs = hit.b.statements[hit.k] as IfStmt;
  if (ifs.init) refuse('an if with an init statement');
  if (ifs.elseBranch) refuse('the if has an else');
  if (ifs.thenBranch.kind !== NodeKind.CompoundStmt) refuse('the arm is not a block');
  const arm = (ifs.thenBranch as CompoundStmt).statements;
  if (arm.length < 2) refuse('the store is the whole arm');
  const st = storeOf(arm[0]);
  if (!st || st.operator !== '=') refuse(`${f.stmt} is not a plain store`);
  const root = storeRoot(st!.left, localNames(fn));
  if (root === '*') refuse(`${f.stmt} stores through memory`);
  // The left side's own address must load nothing either: `x.a[i]` indexes by a value.
  if (!addressLoadsNothing(st!.left)) refuse(`the place ${f.stmt} stores to is computed`);
  if (!loadsNothing(st!.right)) refuse(`the value of ${f.stmt} loads memory or can fault`);
  if (hasCall(ifs.condition) || storedNames(ifs.condition).size > 0) refuse('the condition calls or stores');
  // Dead on the untaken path: the local is named only inside the arm, where the store
  // comes first, and in its declaration.
  const inArm = new Set<ASTNode>();
  for (const { node } of walk(ifs.thenBranch)) inArm.add(node);
  const declNames = new Set<ASTNode>();
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.VariableDecl) continue;
    const d = node as VariableDecl;
    if (d.name.name === root && d.initializer) refuse(`${root} is declared with a value`);
    declNames.add(d.name);
  }
  for (const p of fn.parameters) {
    const n = (p as unknown as { name?: Identifier | null }).name;
    if (n && isId(n, root)) refuse(`${root} is a parameter`);
  }
  for (const { node } of walk(fn.body!)) {
    if (isId(node, root) && !inArm.has(node) && !declNames.has(node)) refuse(`${root} is named outside the arm`);
  }
  hit.b.statements.splice(hit.k, 0, arm.shift()!);
}

/** The nodes of a kind whose text is `want`, in preorder; the i-th (1-based), or the only one for i = 0. */
function pick<T extends ASTNode>(fn: FunctionDecl, want: string, index: number, ok: (n: ASTNode) => n is T, key: (n: T) => ASTNode = n => n): T {
  const w = norm(want);
  const all = [...walk(fn.body!)].map(x => x.node).filter(ok).filter(n => text(key(n)) === w);
  if (index === 0) {
    if (all.length !== 1) refuse(`${all.length} sites of ${want}`);
    return all[0];
  }
  return all[index - 1] ?? refuse(`no site #${index} of ${want}`);
}

function doTarms(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'tarms' }>): void {
  const c = pick(fn, f.cond, f.index, (n): n is ConditionalExpr => n.kind === NodeKind.ConditionalExpr, n => n.condition);
  const t = c.thenExpr;
  c.condition = negate(c.condition);
  c.thenExpr = c.elseExpr;
  c.elseExpr = t;
}

function doZero(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'zero' }>): void {
  const u = pick(fn, f.expr, f.index, (n): n is UnaryExpr => n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '!', n => unparen(n.operand));
  const e: BinaryExpr = { kind: NodeKind.BinaryExpr, operator: '==', left: u.operand, right: intLit(0n, 10) } as unknown as BinaryExpr;
  // The node keeps its identity: rewrite in place.
  for (const k of Object.keys(u)) delete (u as unknown as Record<string, unknown>)[k];
  Object.assign(u, { kind: NodeKind.ParenExpr, expression: e });
}

function doNonzero(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'nonzero' }>): void {
  const w = norm(f.expr);
  const slots: Slot[] = [];
  for (const { node } of walk(fn.body!)) {
    const o = node as unknown as Record<string, unknown>;
    const at = (field: string) => { const e = o[field] as Expression | null; if (e && text(unparen(e)) === w) slots.push({ parent: o, key: field }); };
    if (node.kind === NodeKind.IfStmt || node.kind === NodeKind.WhileStmt || node.kind === NodeKind.DoWhileStmt || node.kind === NodeKind.ForStmt || node.kind === NodeKind.ConditionalExpr) at('condition');
    if (node.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((node as BinaryExpr).operator)) { at('left'); at('right'); }
  }
  const hit = f.index === 0 ? (slots.length === 1 ? slots[0] : refuse(`${slots.length} truth tests of ${f.expr}`)) : (slots[f.index - 1] ?? refuse(`no truth test #${f.index} of ${f.expr}`));
  const e = unparen((hit.parent as Record<string, unknown>)[hit.key as string] as Expression);
  if (e.kind === NodeKind.BinaryExpr && MIRROR[(e as BinaryExpr).operator] !== undefined) refuse(`${f.expr} is a comparison already`);
  put(hit, { kind: NodeKind.BinaryExpr, operator: '!=', left: { kind: NodeKind.ParenExpr, expression: e }, right: intLit(0n, 10) } as unknown as BinaryExpr);
}

/** Every place an expression printed `w` stands tested for truth only, in preorder. */
function truthSlots(fn: FunctionDecl, w: string): Slot[] {
  const slots: Slot[] = [];
  for (const { node } of walk(fn.body!)) {
    const o = node as unknown as Record<string, unknown>;
    const at = (field: string) => { const e = o[field] as Expression | null; if (e && text(unparen(e)) === w) slots.push({ parent: o, key: field }); };
    if (node.kind === NodeKind.IfStmt || node.kind === NodeKind.WhileStmt || node.kind === NodeKind.DoWhileStmt || node.kind === NodeKind.ForStmt || node.kind === NodeKind.ConditionalExpr) at('condition');
    if (node.kind === NodeKind.BinaryExpr && ['&&', '||'].includes((node as BinaryExpr).operator)) { at('left'); at('right'); }
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '!') at('operand');
    if (node.kind === NodeKind.BinaryExpr && ['==', '!='].includes((node as BinaryExpr).operator)) {
      const b = node as BinaryExpr;
      const zero = (e: Expression) => { const l = litValue(e); return !!l && l.v === 0n; };
      if (zero(b.right)) at('left');
      else if (zero(b.left)) at('right');
    }
  }
  return slots;
}

function doBool(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'bool' }>): void {
  const slots = truthSlots(fn, norm(f.expr));
  const hit = f.index === 0
    ? (slots.length === 1 ? slots[0] : refuse(`${slots.length} truth tests of ${f.expr}`))
    : (slots[f.index - 1] ?? refuse(`no truth test #${f.index} of ${f.expr}`));
  const holder = hit.parent as Record<string, unknown>;
  const e = unparen(holder[hit.key as string] as Expression);
  if (maybeFloat(e, fn)) refuse(`${f.expr} may be floating point`);
  const cast = parseExpr('(bool)(__vc8e)') as CStyleCastExpr;
  (cast.expression as ParenExpr).expression = e;
  put(hit, cast);
}

function intLit(v: bigint, base: 10 | 16): Expression {
  const raw = base === 16 ? '0x' + v.toString(16) : v.toString();
  return { kind: NodeKind.IntegerLiteral, value: v, suffix: '', base, raw } as unknown as Expression;
}

/** The signed value of an integer literal, `-N` included; undefined otherwise. */
function litValue(e: Expression): { v: bigint; base: 10 | 16; suffix: string } | undefined {
  e = unparen(e);
  let neg = false;
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '-') { neg = true; e = unparen((e as UnaryExpr).operand); }
  if (e.kind !== NodeKind.IntegerLiteral) return undefined;
  const l = e as unknown as IntegerLiteralExpr;
  if (l.base !== 10 && l.base !== 16) return undefined;
  return { v: neg ? -l.value : l.value, base: l.base, suffix: l.suffix };
}

function litExpr(v: bigint, base: 10 | 16, suffix: string): Expression {
  if (v < 0n) return { kind: NodeKind.UnaryExpr, operator: '-', operand: { ...intLit(-v, base), suffix } } as unknown as Expression;
  return { ...intLit(v, base), suffix } as Expression;
}

/** Whether an expression might be floating point: a float literal, or a cast to float or double. */
function maybeFloat(e: ASTNode, fn: FunctionDecl): boolean {
  const floats = new Set<string>();
  for (const { node } of walk(fn)) {
    if (node.kind === NodeKind.VariableDecl || node.kind === NodeKind.ParameterDecl) {
      const d = node as unknown as { name?: Identifier | null; type: TypeNode };
      if (d.name && /\b(float|double)\b/.test(emit(d.type as never))) floats.add(d.name.name);
    }
  }
  for (const { node } of walk(e)) {
    if (node.kind === NodeKind.FloatingLiteral) return true;
    if (node.kind === NodeKind.CStyleCastExpr && /\b(float|double)\b/.test(text((node as CStyleCastExpr).type))) return true;
    if (isId(node) && floats.has(node.name)) return true;
  }
  return false;
}

const SIGNED = /^(int|signedint|long|signedlong|short|signedshort|shortint|signedchar|int8_t|int16_t|int32_t|BOOL|LONG|INT|SHORT)$/;

/** Whether an expression is known to be signed: a local or parameter declared signed, or a cast to a signed type. */
function signedSide(e: Expression, fn: FunctionDecl): boolean {
  e = unparen(e);
  if (e.kind === NodeKind.CStyleCastExpr) return SIGNED.test(text((e as CStyleCastExpr).type));
  if (!isId(e)) return false;
  let t: string | undefined;
  for (const { node } of walk(fn)) {
    if (node.kind !== NodeKind.VariableDecl && node.kind !== NodeKind.ParameterDecl) continue;
    const d = node as unknown as { name?: Identifier | null; type: TypeNode };
    if (d.name && d.name.name === e.name) t = text(d.type);
  }
  return t !== undefined && SIGNED.test(t);
}

const MIRROR: Record<string, string> = { '<': '>', '>': '<', '<=': '>=', '>=': '<=', '==': '==', '!=': '!=' };
const LIT: Record<string, { op: string; d: bigint }> = { '<': { op: '<=', d: -1n }, '<=': { op: '<', d: 1n }, '>': { op: '>=', d: 1n }, '>=': { op: '>', d: -1n } };

const effects = (e: ASTNode) => [...walk(e)].some(x => x.node.kind === NodeKind.CallExpr || x.node.kind === NodeKind.AssignExpr || x.node.kind === NodeKind.PostfixExpr ||
  (x.node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((x.node as UnaryExpr).operator)));

function doCmp(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'cmp' }>): void {
  const c = pick(fn, f.cond, f.index, (n): n is BinaryExpr => n.kind === NodeKind.BinaryExpr && MIRROR[(n as BinaryExpr).operator] !== undefined);
  if (f.how === 'mirror' || f.how === 'mirror-lit') {
    if (effects(c.left) && effects(c.right)) refuse('both sides have effects');
    const l = c.left;
    c.left = c.right; c.right = l;
    c.operator = MIRROR[c.operator] as BinaryExpr['operator'];
  }
  if (f.how === 'lit' || f.how === 'mirror-lit') {
    const m = LIT[c.operator];
    const lv = litValue(c.right);
    if (!m || !lv) refuse('no integer literal bound');
    if (maybeFloat(c.left, fn)) refuse('the compare may be floating point');
    const nv = lv!.v + m.d;
    // Stay inside one 32-bit range on both readings: no wrap at the signed or unsigned edge.
    if (nv < -0x80000000n || nv > 0xffffffffn || (lv!.v <= 0x7fffffffn) !== (nv <= 0x7fffffffn)) refuse('the bound would cross a range edge');
    // -1 and 0 are one apart only when the left side is signed: unsigned, -1 is the maximum.
    if ((lv!.v >= 0n) !== (nv >= 0n) && !signedSide(c.left, fn)) refuse('the bound would cross zero on a side not known to be signed');
    c.operator = m.op as BinaryExpr['operator'];
    c.right = litExpr(nv, lv!.base, lv!.suffix);
  }
}

const COMMUTES = new Set(['+', '*', '&', '|', '^']);

function doSwap(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'swap' }>): void {
  const b = pick(fn, f.expr, f.index, (n): n is BinaryExpr => n.kind === NodeKind.BinaryExpr && COMMUTES.has((n as BinaryExpr).operator));
  if (effects(b.left) && effects(b.right)) refuse('both operands have effects');
  const l = b.left;
  b.left = b.right; b.right = l;
}

function doIfsel(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'ifsel' }>): void {
  const store = (v: Expression) => ({ kind: NodeKind.CompoundStmt, statements: [{ kind: NodeKind.ExprStmt, expression: { kind: NodeKind.AssignExpr, operator: '=', left: { kind: NodeKind.Identifier, name: f.name }, right: v } }] }) as unknown as CompoundStmt;
  const hits: Array<{ b: CompoundStmt; k: number; c: ConditionalExpr; decl?: VariableDecl }> = [];
  for (const b of blocks(fn)) {
    b.statements.forEach((s, k) => {
      const st = storeOf(s); const d = declOf(s);
      if (st && st.operator === '=' && isId(unparen(st.left), f.name) && unparen(st.right).kind === NodeKind.ConditionalExpr) hits.push({ b, k, c: unparen(st.right) as ConditionalExpr });
      else if (d && d.name.name === f.name && d.initializer && unparen(d.initializer as Expression).kind === NodeKind.ConditionalExpr) hits.push({ b, k, c: unparen(d.initializer as Expression) as ConditionalExpr, decl: d });
    });
  }
  if (hits.length !== 1) refuse(`${hits.length} selects into ${f.name}`);
  const { b, k, c, decl } = hits[0];
  const sel = { kind: NodeKind.IfStmt, condition: c.condition, thenBranch: store(c.thenExpr), elseBranch: store(c.elseExpr), isConstexpr: false } as unknown as IfStmt;
  if (decl) {
    decl.initializer = null;
    b.statements.splice(k + 1, 0, sel);
  } else b.statements.splice(k, 1, sel);
}

function doSplit(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'split' }>): void {
  if (localNames(fn).has(f.rename)) refuse(`${f.rename} exists`);
  if (addressTaken(fn, f.name)) refuse(`&${f.name} is taken`);
  const parents = parentsOf(fn);
  const inLoop = (n: ASTNode) => { for (let p = parents.get(n); p; p = parents.get(p)) if ([NodeKind.WhileStmt, NodeKind.DoWhileStmt, NodeKind.ForStmt].includes(p.kind)) return true; return false; };
  const sites: Array<{ b: CompoundStmt; k: number; end: number }> = [];
  for (const b of blocks(fn)) {
    for (let k = 0; k < b.statements.length; k++) {
      const st = storeOf(b.statements[k]);
      // A store that reads V's old value (`V = V * k`) begins a new life too: the new
      // variable's initializer reads V, which still holds that value there.
      if (!st || st.operator !== '=' || !isId(unparen(st.left), f.name)) continue;
      // Its life: up to the next plain store to V that does not read V, in this block.
      let end = k + 1;
      for (; end < b.statements.length; end++) {
        const n = storeOf(b.statements[end]);
        if (n && n.operator === '=' && isId(unparen(n.left), f.name) && !mentions(n.right, f.name)) break;
      }
      sites.push({ b, k, end });
    }
  }
  // The life to split is the only one after which nothing reads V: at the end of its block
  // the value must be dead.
  const ok = sites.filter(({ b, k, end }) => {
    const life = b.statements.slice(k + 1, end);
    if (!life.some(s => mentions(s, f.name))) return false;
    if (life.some(s => storedNames(s).has(f.name))) return false;
    if (inLoop(b.statements[k])) return false;
    if (end === b.statements.length && blockReadsAfter(fn, b, f.name, k)) return false;
    return true;
  });
  if (ok.length === 0) refuse(`no life of ${f.name} to split`);
  // The last such life: the earlier ones are the original variable's.
  const { b, k, end } = ok[ok.length - 1];
  const st = storeOf(b.statements[k])!;
  const decl = parse(`void __vc8f() { ${f.type} ${f.rename} = 0; }`).declarations[0] as FunctionDecl;
  const d = decl.body!.statements[0];
  declOf(d)!.initializer = st.right;
  b.statements[k] = d;
  for (const s of b.statements.slice(k + 1, end)) for (const { node } of walk(s)) if (isId(node, f.name)) (node as Identifier).name = f.rename;
}

let selectTables: Vc8FormTables | undefined;

function doTsel(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'tsel' }>): void {
  try {
    selectPairedArguments(fn, f.cond, f.index, selectTables);
  } catch (e) {
    if (e instanceof SelectRefused) refuse(e.message);
    throw e;
  }
}

// ---------------------------------------------------------------------------------------
// Call and string-instruction forms

/** The declared type of a local or parameter, as printed, or undefined. */
function declaredType(fn: FunctionDecl, v: string): string | undefined {
  for (const p of fn.parameters) {
    const n = (p as unknown as { name?: Identifier | null; type: TypeNode }).name;
    if (n && isId(n, v)) return norm(emit((p as unknown as { type: TypeNode }).type as never));
  }
  for (const { node } of walk(fn.body!)) {
    if (node.kind === NodeKind.VariableDecl && (node as VariableDecl).name.name === v) return norm(emit((node as VariableDecl).type as never));
  }
  return undefined;
}

/** Arithmetic types a stored value can be narrowed, widened or rounded by. */
const CONVERTS = new Set(['char', 'signedchar', 'unsignedchar', 'int8_t', 'uint8_t', 'BYTE', 'CHAR', 'UCHAR', 'byte', 'bool',
  'short', 'shortint', 'unsignedshort', 'unsignedshortint', 'int16_t', 'uint16_t', 'ushort', 'WORD', 'WCHAR', 'wchar_t', 'SHORT', 'USHORT',
  'float', 'double', 'longdouble', 'FLOAT', 'longlong', 'unsignedlonglong', '__int64', 'unsigned__int64', 'int64_t', 'uint64_t',
  'LONGLONG', 'ULONGLONG', 'QWORD', 'DWORD64']);
/**
 * A type whose store keeps a call's value as is: a pointer, a 32-bit integer, an enum, a
 * class. An arithmetic type of another width or a floating one may convert the value on the
 * store where the argument would take it unconverted; an implicit conversion into anything
 * else needs the call to return that very type.
 */
const keepsValue = (t: string | undefined) => !!t && !/[\[\]()]/.test(t) && (t.endsWith('*') || !CONVERTS.has(t.replace(/^const/, '')));

/**
 * An expression that, evaluated earlier or later around a call, has the same value: it calls
 * nothing, stores nothing and reads only constants and locals whose address is not taken
 * (the call cannot write those), with no division that could fault.
 */
function callProof(fn: FunctionDecl, e: Expression, locals: Set<string>): boolean {
  e = unparen(e);
  switch (e.kind) {
    case NodeKind.IntegerLiteral: case NodeKind.FloatingLiteral: case NodeKind.CharLiteral:
    case NodeKind.StringLiteral: case NodeKind.BoolLiteral: case NodeKind.NullptrLiteral:
      return true;
    case NodeKind.SizeofExpr: return true;
    case NodeKind.Identifier: return locals.has((e as Identifier).name) && !addressTaken(fn, (e as Identifier).name);
    case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr: case NodeKind.ReinterpretCastExpr: case NodeKind.ConstCastExpr:
      return callProof(fn, (e as CStyleCastExpr).expression, locals);
    case NodeKind.BinaryExpr: {
      const b = e as BinaryExpr;
      return !['/', '%'].includes(b.operator) && callProof(fn, b.left, locals) && callProof(fn, b.right, locals);
    }
    case NodeKind.UnaryExpr: {
      const u = e as UnaryExpr;
      // The address of a local loads nothing; it is no read of the local either.
      if (u.operator === '&') { const o = unparen(u.operand); return isId(o) && locals.has(o.name); }
      return ['-', '+', '~', '!'].includes(u.operator) && callProof(fn, u.operand, locals);
    }
  }
  return false;
}

/** A callee that names a function: evaluating it reads nothing a call could change. */
const namedCallee = (e: Expression) => { e = unparen(e); return e.kind === NodeKind.Identifier || e.kind === NodeKind.QualifiedId; };

/**
 * What a loop does to v first, where readFirst would call any mention a read: a for or
 * while loop whose head does not name v and whose body stores it first may run no time
 * (`none`); a do-while body runs once (its own answer).
 */
function loopFirst(s: Statement, v: string): 'read' | 'store' | 'none' | undefined {
  const l = s as unknown as { init?: Statement | null; condition?: Expression | null; increment?: Expression | null; body: Statement };
  for (const { node } of walk(s)) if (LIFE_JUMPS.has(node.kind) && node.kind !== NodeKind.BreakStmt && node.kind !== NodeKind.ContinueStmt) return undefined;
  if (s.kind === NodeKind.DoWhileStmt) return readFirst(l.body, v);
  if (s.kind !== NodeKind.ForStmt && s.kind !== NodeKind.WhileStmt) return undefined;
  if ((l.init && mentions(l.init, v)) || (l.condition && mentions(l.condition, v)) || (l.increment && mentions(l.increment, v))) return undefined;
  return readFirst(l.body, v) === 'store' ? 'none' : undefined;
}

/** Whether V is dead after statement k+1 of b: its next mention stores it first, or there is none and nothing after b reads it. */
function deadAfter(fn: FunctionDecl, b: CompoundStmt, k: number, last: number, v: string): boolean {
  for (const s of b.statements.slice(last + 1)) {
    if (!mentions(s, v)) {
      for (const { node } of walk(s)) if (LIFE_JUMPS.has(node.kind)) return false;
      continue;
    }
    const r = loopFirst(s, v) ?? readFirst(s, v);
    if (r !== 'none') return r === 'store';
    // Stored on some paths only: what follows may still read the old value.
  }
  return !blockReadsAfter(fn, b, v, k, true);
}

function doNestcall(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'nestcall' }>): void {
  const v = f.name;
  const hits: Array<{ b: CompoundStmt; k: number; value: Expression; decl?: VariableDecl }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    const st = storeOf(s), d = declOf(s);
    if (st && st.operator === '=' && isId(unparen(st.left), v) && unparen(st.right).kind === NodeKind.CallExpr) hits.push({ b, k, value: st.right });
    else if (d && d.name.name === v && d.initializer && d.initializer.kind !== NodeKind.InitListExpr && unparen(d.initializer as Expression).kind === NodeKind.CallExpr) hits.push({ b, k, value: d.initializer as Expression, decl: d });
  });
  const hit = f.index === 0 ? (hits.length === 1 ? hits[0] : refuse(`${hits.length} calls stored to ${v}`)) : (hits[f.index - 1] ?? refuse(`no call #${f.index} stored to ${v}`));
  const { b, k } = hit;
  if (addressTaken(fn, v)) refuse(`&${v} is taken`);
  if (!keepsValue(declaredType(fn, v))) refuse(`${v}'s type may convert the stored value`);
  if (mentions(hit.value, v)) refuse(`${v} is stored from itself`);
  const next = b.statements[k + 1] ?? refuse('nothing follows the store');
  // The expression the call moves into: the statement's own, never a loop's.
  let root: Expression | undefined;
  if (next.kind === NodeKind.ExprStmt) root = (next as ExprStmt).expression;
  else if (next.kind === NodeKind.ReturnStmt) root = (next as ReturnStmt).value ?? undefined;
  else if (next.kind === NodeKind.DeclStmt) { const d = declOf(next); root = d && d.initializer && d.initializer.kind !== NodeKind.InitListExpr ? d.initializer as Expression : undefined; }
  else if (next.kind === NodeKind.IfStmt && !(next as IfStmt).init) {
    root = (next as IfStmt).condition;
    for (const br of [(next as IfStmt).thenBranch, (next as IfStmt).elseBranch]) if (br && mentions(br, v)) refuse(`${v} is read in an arm`);
  } else if (next.kind === NodeKind.SwitchStmt) {
    root = (next as unknown as { condition: Expression }).condition;
    if (mentions((next as unknown as { body: Statement }).body, v)) refuse(`${v} is read in the switch`);
  }
  if (!root) refuse('the next statement is no expression, return, declaration, if or switch');
  const uses = [...walk(root!)].filter(x => isId(x.node, v) && x.slot);
  if (uses.length !== 1) refuse(`${v} is read ${uses.length} times by the next statement`);
  if (storedNames(next).has(v)) refuse(`the next statement stores ${v}`);
  // Up from the use: parentheses and casts, then a call's argument or a member's object.
  const parents = new Map<ASTNode, ASTNode>();
  for (const { node, slot } of walk(root!)) {
    if (!slot) continue;
    if (!Array.isArray(slot.parent)) parents.set(node, slot.parent as unknown as ASTNode);
    else for (const { node: owner } of walk(root!)) {
      const o = owner as unknown as Record<string, unknown>;
      if (Object.values(o).includes(slot.parent)) { parents.set(node, owner); break; }
    }
  }
  const locals = localNames(fn);
  const CASTS = new Set<string>([NodeKind.ParenExpr, NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr, NodeKind.ConstCastExpr]);
  let c: ASTNode = uses[0].node;
  while (parents.has(c) && CASTS.has(parents.get(c)!.kind)) c = parents.get(c)!;
  const first = parents.get(c);
  const place = !!first && ((first.kind === NodeKind.CallExpr && (first as CallExpr).arguments.includes(c as Expression))
    || (first.kind === NodeKind.MemberExpr && (first as unknown as { object: ASTNode }).object === c));
  if (!place) refuse(`${v} is not a whole argument or the object of a member`);
  // Everything that may be evaluated before the call in its new place must not care.
  const proof = (e: Expression | null | undefined) => !e || callProof(fn, e, locals);
  for (let p = parents.get(c); p; c = p, p = parents.get(p)) {
    switch (p.kind) {
      case NodeKind.ParenExpr: case NodeKind.CStyleCastExpr: case NodeKind.StaticCastExpr:
      case NodeKind.ReinterpretCastExpr: case NodeKind.ConstCastExpr: case NodeKind.MemberExpr:
        break;
      case NodeKind.UnaryExpr:
        if (['++', '--'].includes((p as UnaryExpr).operator)) refuse('the call would be stored to');
        break;
      case NodeKind.PostfixExpr: refuse('the call would be stored to'); break;
      case NodeKind.SubscriptExpr: {
        const s = p as unknown as { array: Expression; index: Expression };
        if (s.index === c && !proof(s.array)) refuse('the subscripted value calls, stores or reads memory');
        break;
      }
      case NodeKind.CallExpr: {
        const call = p as CallExpr;
        if (call.callee === c) break;
        if (!namedCallee(call.callee) && !proof(call.callee)) refuse('the callee is computed');
        for (const a of call.arguments) if (a !== c && !proof(a)) refuse(`the argument ${text(a)} calls, stores or reads memory`);
        break;
      }
      case NodeKind.BinaryExpr: {
        const e = p as BinaryExpr;
        if (e.operator === '&&' || e.operator === '||') { if (e.right === c) refuse(`the call would be conditional on ${e.operator}`); break; }
        if (!proof(e.left === c ? e.right : e.left)) refuse(`the other operand of ${e.operator} calls, stores or reads memory`);
        break;
      }
      case NodeKind.AssignExpr: {
        // The right side is evaluated before the left (C++17): only a use on the left moves.
        const a = p as AssignExpr;
        if (a.left === c && !proof(a.right)) refuse('the stored value calls, stores or reads memory');
        break;
      }
      case NodeKind.ConditionalExpr:
        if ((p as ConditionalExpr).condition !== c) refuse('the call would be conditional on ?:');
        break;
      case NodeKind.CommaExpr: {
        const xs = (p as unknown as { expressions: Expression[] }).expressions;
        for (const x of xs.slice(0, xs.indexOf(c as Expression))) if (!proof(x)) refuse('a comma operand before it calls, stores or reads memory');
        break;
      }
      default: refuse(`the call cannot go under ${p.kind}`);
    }
  }
  if (!deadAfter(fn, b, k, k + 1, v)) refuse(`${v} is read after the next statement`);
  put(uses[0].slot!, cloneNode(hit.value));
  if (hit.decl && mentionsOutsideDecl(fn, v)) hit.decl.initializer = null;
  else b.statements.splice(k, 1);
  if (!mentionsOutsideDecl(fn, v)) removeDecl(fn, v);
}

const ELEMENT_SIZE: Record<string, number> = {
  uint8_t: 1, int8_t: 1, char: 1, signedchar: 1, unsignedchar: 1, BYTE: 1, CHAR: 1, byte: 1, bool: 1,
  uint16_t: 2, int16_t: 2, wchar_t: 2, WORD: 2, WCHAR: 2, short: 2, shortint: 2, unsignedshort: 2, unsignedshortint: 2, ushort: 2,
  uint32_t: 4, int32_t: 4, int: 4, unsignedint: 4, DWORD: 4, BOOL: 4, long: 4, longint: 4, unsignedlong: 4, unsignedlongint: 4, UINT: 4,
};

/** An integer literal's value, or undefined. */
function intValue(e: Expression | null | undefined): bigint | undefined {
  if (!e) return undefined;
  const l = litValue(unparen(e));
  return l?.v;
}

/** `N = K` (or `int N = K`) for a for-loop's init: [N, K]. */
function countInit(s: Statement | null): [string, bigint] | undefined {
  if (!s) return undefined;
  const st = storeOf(s);
  if (st && st.operator === '=' && isId(unparen(st.left))) { const k = intValue(st.right); return k === undefined ? undefined : [(unparen(st.left) as Identifier).name, k]; }
  return undefined;
}

/** `for (N = K; N; N--)` (or `N != 0`, `--N`, `N -= 1`): [N, K]. */
function countdown(s: Statement): [string, bigint] | undefined {
  if (s.kind !== NodeKind.ForStmt) return undefined;
  const f = s as ForStmt;
  const init = countInit(f.init);
  if (!init || init[1] <= 0n) return undefined;
  const [n] = init;
  const c = f.condition && unparen(f.condition);
  const tests = !!c && (isId(c, n) || (c.kind === NodeKind.BinaryExpr && (c as BinaryExpr).operator === '!=' && isId(unparen((c as BinaryExpr).left), n) && intValue((c as BinaryExpr).right) === 0n));
  if (!tests || !f.increment || !steps(f.increment, n, '-')) return undefined;
  return init;
}

/** `X++`, `++X`, `X += 1` (or with '-'), for an identifier X. */
function steps(e: Expression, x: string, dir: '+' | '-'): boolean {
  e = unparen(e);
  if ((e.kind === NodeKind.PostfixExpr || e.kind === NodeKind.UnaryExpr) && (e as UnaryExpr).operator === dir + dir) return isId(unparen((e as UnaryExpr).operand), x);
  if (e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === dir + '=') return isId(unparen((e as AssignExpr).left), x) && intValue((e as AssignExpr).right) === 1n;
  return false;
}

/** `X += m` for an identifier X: m, or undefined. */
function stepBy(s: Statement, x: string): bigint | undefined {
  const st = storeOf(s);
  if (!st || st.operator !== '+=' || !isId(unparen(st.left), x)) return undefined;
  return intValue(st.right);
}

/** A literal zero: `0`, `0x0`, or the character `'\\0'` / `L'\\0'`. */
const isZero = (e: Expression) => { const u = unparen(e); return intValue(u) === 0n || (u.kind === NodeKind.CharLiteral && (u as unknown as { value: number }).value === 0); };

function fillLoop(name: string, from: bigint, to: bigint): Statement {
  if (to > 0x7fffffffn || from < 0n) refuse('a bound leaves int');
  const hex = (v: bigint) => (v > 9n ? '0x' + v.toString(16) : v.toString());
  const fn = parse(`void __vc8f() { for (int i = ${hex(from)}; i < ${hex(to)}; i++) ${name}[i] = 0; }`).declarations[0] as FunctionDecl;
  return fn.body!.statements[0];
}

interface FillSite { b: CompoundStmt; k: number; count: number; loop: Statement; dead: string[]; keepDecl?: VariableDecl }

function fillSites(fn: FunctionDecl, a: string): FillSite[] {
  const out: FillSite[] = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    // memset(A[ + K], 0, N * sizeof(A[0])) or a byte count.
    if (s.kind === NodeKind.ExprStmt && unparen((s as ExprStmt).expression).kind === NodeKind.CallExpr) {
      const call = unparen((s as ExprStmt).expression) as CallExpr;
      if (text(call.callee) !== 'memset' || call.arguments.length !== 3 || !isZero(call.arguments[1])) return;
      let dst = unparen(call.arguments[0]), off = 0n;
      if (dst.kind === NodeKind.BinaryExpr && (dst as BinaryExpr).operator === '+') {
        const o = intValue((dst as BinaryExpr).right);
        if (o === undefined) return;
        off = o; dst = unparen((dst as BinaryExpr).left);
      }
      if (!isId(dst, a)) return;
      const size = unparen(call.arguments[2]);
      let n: bigint | undefined;
      if (size.kind === NodeKind.BinaryExpr && (size as BinaryExpr).operator === '*') {
        const r = unparen((size as BinaryExpr).right);
        // `sizeof(a[0])` may parse as the type `a[0]`: either prints the same.
        if (r.kind === NodeKind.SizeofExpr && norm(emit((r as unknown as { operand: ASTNode }).operand as never)) === `${a}[0]`) n = intValue((size as BinaryExpr).left);
      } else {
        const bytes = intValue(size);
        const t = declaredType(fn, a);
        const m = t && /^(.*)\[[^\]]*\]$/.exec(t);
        const el = m ? ELEMENT_SIZE[m[1].replace(/^const/, '')] : undefined;
        if (bytes !== undefined && el && bytes % BigInt(el) === 0n) n = bytes / BigInt(el);
      }
      if (n === undefined || n <= 0n) return;
      out.push({ b, k, count: 1, loop: fillLoop(a, off, off + n), dead: [] });
      return;
    }
    // P = A; for (N = K; N; N--) { P[0] = 0; ... P += m; }
    const loop = b.statements[k + 1];
    const cd = loop && countdown(loop);
    if (!cd) return;
    const st = storeOf(s), d = declOf(s);
    let p: string | undefined, from: Expression | undefined;
    if (st && st.operator === '=' && isId(unparen(st.left))) { p = (unparen(st.left) as Identifier).name; from = st.right; }
    else if (d && d.initializer && d.initializer.kind !== NodeKind.InitListExpr) { p = d.name.name; from = d.initializer as Expression; }
    // `P = A` with no cast: P points at A's elements.
    if (!p || !from || !isId(from, a) || p === a || p === cd[0] || cd[0] === a) return;
    const body = stmtsOf((loop as ForStmt).body);
    let m: bigint | undefined;
    if (body.length === 2 && storeOf(body[0]) && body[1].kind === NodeKind.ExprStmt && steps((body[1] as ExprStmt).expression, p, '+')) {
      const z = storeOf(body[0])!;
      const l = unparen(z.left);
      if (z.operator === '=' && l.kind === NodeKind.UnaryExpr && (l as UnaryExpr).operator === '*' && isId(unparen((l as UnaryExpr).operand), p) && isZero(z.right)) m = 1n;
    } else if (body.length >= 3) {
      const by = stepBy(body[body.length - 1], p);
      const ok = body.slice(0, -1).every((x, j) => {
        const z = storeOf(x);
        if (!z || z.operator !== '=' || !isZero(z.right)) return false;
        const l = unparen(z.left) as unknown as { kind: string; array: Expression; index: Expression };
        return l.kind === NodeKind.SubscriptExpr && isId(unparen(l.array), p) && intValue(l.index) === BigInt(j);
      });
      if (ok && by === BigInt(body.length - 1)) m = by;
    }
    if (!m) return;
    out.push({ b, k, count: 2, loop: fillLoop(a, 0n, cd[1] * m), dead: [p, cd[0]], keepDecl: d });
  });
  return out;
}

function doFill(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'fill' }>): void {
  const sites = fillSites(fn, f.name);
  const hit = f.index === 0 ? (sites.length === 1 ? sites[0] : refuse(`${sites.length} fills of ${f.name}`)) : (sites[f.index - 1] ?? refuse(`no fill #${f.index} of ${f.name}`));
  for (const v of hit.dead) {
    if (!localNames(fn).has(v) || addressTaken(fn, v)) refuse(`${v} is no local, or its address is taken`);
    if (!deadAfter(fn, hit.b, hit.k, hit.k + hit.count - 1, v)) refuse(`${v} is read after the loop`);
  }
  const repl: Statement[] = [hit.loop];
  if (hit.keepDecl) {
    // The pointer's declaration stays while the pointer is named elsewhere.
    const d = cloneNode(hit.b.statements[hit.k]) as DeclStmt;
    (d.declarations[0] as VariableDecl).initializer = null;
    repl.unshift(d);
  }
  hit.b.statements.splice(hit.k, hit.count, ...repl);
  // The pointer and the counter go once nothing names them.
  for (const v of hit.dead) if (!mentionsOutsideDecl(fn, v)) removeDecl(fn, v);
}

/** The pointee of a pointer type as printed, or undefined. */
const pointee = (t: string | undefined) => (t && t.endsWith('*') ? t.slice(0, -1).replace(/^const/, '') : undefined);

/**
 * Whether pointer `p` provably points into a local no other pointer can reach at statement
 * `at` of b: its last store before `at` in b, outside any loop, is the address of (or the
 * array) L, a local of the body named nowhere before that store.
 */
function freshLocal(fn: FunctionDecl, b: CompoundStmt, at: number, p: string): boolean {
  let k = at - 1;
  for (; k >= 0; k--) if (mentions(b.statements[k], p)) break;
  if (k < 0) return false;
  const st = storeOf(b.statements[k]), d = declOf(b.statements[k]);
  let value: Expression | undefined;
  if (st && st.operator === '=' && isId(unparen(st.left), p)) value = st.right;
  else if (d && d.name.name === p && d.initializer && d.initializer.kind !== NodeKind.InitListExpr) value = d.initializer as Expression;
  if (!value) return false;
  let e = unparen(value);
  while (e.kind === NodeKind.CStyleCastExpr || e.kind === NodeKind.ReinterpretCastExpr || e.kind === NodeKind.StaticCastExpr) e = unparen((e as CStyleCastExpr).expression);
  if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '&') e = unparen((e as UnaryExpr).operand);
  if (!isId(e)) return false;
  const l = e.name;
  // A local of the body (not a parameter, not static), declared before.
  let local: VariableDecl | undefined;
  for (const { node } of walk(fn.body!)) if (node.kind === NodeKind.VariableDecl && (node as VariableDecl).name.name === l) local = node as VariableDecl;
  if (!local || local.specifiers.some(s => s === 'static' || s === 'extern')) return false;
  // Named nowhere before the store, in preorder, and the store is in no loop.
  const store = b.statements[k];
  for (const { node } of walk(fn.body!)) {
    if (node === store) break;
    if (isId(node, l) && node !== local.name) return false;
  }
  const parents = parentsOf(fn);
  for (let n: ASTNode | undefined = store; n; n = parents.get(n)) {
    if (n.kind === NodeKind.WhileStmt || n.kind === NodeKind.ForStmt || n.kind === NodeKind.DoWhileStmt) return false;
  }
  // Nor between the store and the loop.
  return !b.statements.slice(k + 1, at).some(s => mentions(s, l));
}

function doCopy(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'copy' }>): void {
  const dst = f.name;
  const sites: Array<{ b: CompoundStmt; k: number; src: string; n: string; count: bigint }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    const cd = countdown(s);
    if (!cd) return;
    const body = stmtsOf((s as ForStmt).body);
    if (body.length !== 3) return;
    const z = storeOf(body[0]);
    if (!z || z.operator !== '=') return;
    const l = unparen(z.left), r = unparen(z.right);
    if (l.kind !== NodeKind.UnaryExpr || (l as UnaryExpr).operator !== '*' || !isId(unparen((l as UnaryExpr).operand), dst)) return;
    if (r.kind !== NodeKind.UnaryExpr || (r as UnaryExpr).operator !== '*' || !isId(unparen((r as UnaryExpr).operand))) return;
    const src = (unparen((r as UnaryExpr).operand) as Identifier).name;
    if (new Set([dst, src, cd[0]]).size !== 3) return;
    const inc = body.slice(1).map(x => (x.kind === NodeKind.ExprStmt ? (x as ExprStmt).expression : undefined));
    const ok = inc.every(e => e && (steps(e, dst, '+') || steps(e, src, '+'))) && inc.some(e => steps(e!, dst, '+')) && inc.some(e => steps(e!, src, '+'));
    if (ok) sites.push({ b, k, src, n: cd[0], count: cd[1] });
  });
  const hit = f.index === 0 ? (sites.length === 1 ? sites[0] : refuse(`${sites.length} copy loops into ${dst}`)) : (sites[f.index - 1] ?? refuse(`no copy loop #${f.index} into ${dst}`));
  const td = pointee(declaredType(fn, dst)), ts = pointee(declaredType(fn, hit.src));
  if (!td || td !== ts) refuse(`${dst} and ${hit.src} are not declared pointers to one type`);
  for (const v of [dst, hit.src, hit.n]) {
    if (!localNames(fn).has(v) || addressTaken(fn, v)) refuse(`${v} is no local, or its address is taken`);
    if (!deadAfter(fn, hit.b, hit.k, hit.k, v)) refuse(`${v} is read after the loop`);
  }
  if (!freshLocal(fn, hit.b, hit.k, dst) && !freshLocal(fn, hit.b, hit.k, hit.src)) refuse('the two ranges are not provably apart');
  const k = hit.count > 9n ? '0x' + hit.count.toString(16) : hit.count.toString();
  const call = (parse(`void __vc8f() { memcpy(${dst}, ${hit.src}, ${k} * sizeof(*${dst})); }`).declarations[0] as FunctionDecl).body!.statements[0];
  hit.b.statements.splice(hit.k, 1, call);
}

/** The integer types a shift operand may have here, by printed spelling: width and signedness. */
const SHIFT_INTS: Record<string, { bits: number; signed: boolean }> = {
  'int': { bits: 32, signed: true }, 'int32_t': { bits: 32, signed: true }, 'long': { bits: 32, signed: true },
  'INT': { bits: 32, signed: true }, 'LONG': { bits: 32, signed: true }, 'BOOL': { bits: 32, signed: true },
  'unsignedint': { bits: 32, signed: false }, 'uint32_t': { bits: 32, signed: false }, 'uint': { bits: 32, signed: false },
  'DWORD': { bits: 32, signed: false }, 'UINT': { bits: 32, signed: false }, 'ULONG': { bits: 32, signed: false },
  'unsignedlong': { bits: 32, signed: false }, 'size_t': { bits: 32, signed: false },
  'short': { bits: 16, signed: true }, 'shortint': { bits: 16, signed: true }, 'int16_t': { bits: 16, signed: true }, 'SHORT': { bits: 16, signed: true },
  'uint16_t': { bits: 16, signed: false }, 'WORD': { bits: 16, signed: false }, 'ushort': { bits: 16, signed: false },
  'unsignedshort': { bits: 16, signed: false }, 'USHORT': { bits: 16, signed: false }, 'wchar_t': { bits: 16, signed: false },
  'char': { bits: 8, signed: true }, 'signedchar': { bits: 8, signed: true }, 'int8_t': { bits: 8, signed: true }, 'CHAR': { bits: 8, signed: true },
  'uint8_t': { bits: 8, signed: false }, 'BYTE': { bits: 8, signed: false }, 'byte': { bits: 8, signed: false },
  'unsignedchar': { bits: 8, signed: false }, 'UCHAR': { bits: 8, signed: false },
};

/** The unsigned 32-bit spellings a logical shift's operand cast may have. */
const SHIFT_U32 = new Set(['uint32_t', 'uint', 'unsignedint', 'DWORD', 'UINT', 'ULONG', 'unsignedlong']);
const SHIFT_S32 = new Set(['int', 'int32_t', 'INT', 'LONG', 'long']);

function doShift(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'shift' }>): void {
  const w = norm(f.expr);
  // E's declared type: a parameter or a local of the function.
  let et: { bits: number; signed: boolean } | undefined;
  let decls = 0;
  for (const { node } of walk(fn)) {
    if (node.kind !== NodeKind.VariableDecl && node.kind !== NodeKind.ParameterDecl) continue;
    const d = node as unknown as { name?: Identifier | null; type: TypeNode };
    if (!d.name || d.name.name !== w) continue;
    decls++;
    et = SHIFT_INTS[text(d.type)];
  }
  if (decls !== 1) refuse(`${f.expr} is not one local or parameter`);
  if (!et) refuse(`${f.expr} has no known integer type of at most 32 bits`);
  const sites: Array<{ shift: BinaryExpr; operand: Expression; cast?: CStyleCastExpr }> = [];
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.CStyleCastExpr) continue;
    const c = node as CStyleCastExpr;
    const t = SHIFT_INTS[text(c.type)];
    if (!t || t.bits >= 32) continue;
    const sh = unparen(c.expression as Expression);
    if (sh.kind !== NodeKind.BinaryExpr || (sh as BinaryExpr).operator !== '>>') continue;
    const k = litValue((sh as BinaryExpr).right as Expression);
    if (!k || k.v < 1n || BigInt(t.bits) + k.v > 32n) continue;
    let operand = unparen((sh as BinaryExpr).left as Expression);
    let inner: CStyleCastExpr | undefined;
    if (operand.kind === NodeKind.CStyleCastExpr) {
      const ct = text((operand as CStyleCastExpr).type);
      if (!SHIFT_U32.has(ct) && !SHIFT_S32.has(ct)) continue;
      inner = operand as CStyleCastExpr;
      operand = unparen(inner.expression as Expression);
    }
    if (text(operand) !== w) continue;
    sites.push({ shift: sh as BinaryExpr, operand, cast: inner });
  }
  const hit = f.index === 0
    ? (sites.length === 1 ? sites[0] : refuse(`${sites.length} narrowed shifts of ${f.expr}`))
    : (sites[f.index - 1] ?? refuse(`no narrowed shift #${f.index} of ${f.expr}`));
  // The shift as written now, and the one asked for.
  const nowSigned = hit.cast ? SHIFT_S32.has(text(hit.cast.type)) : et.signed;
  const wantSigned = f.how === 'sar';
  if (nowSigned === wantSigned) refuse(`the shift of ${f.expr} is already ${f.how}`);
  const left = et.signed === wantSigned
    ? hit.operand
    : parseExpr(`(${wantSigned ? 'int' : 'uint32_t'})__vc8e`);
  if (left !== hit.operand) ((left as CStyleCastExpr).expression as unknown) = hit.operand;
  (hit.shift as unknown as Record<string, unknown>).left = left;
}

/** A global the generator declares as an array (its address cannot change), by its last name part. */
function globalArray(name: string): boolean {
  const t = selectTables?.globalTypes?.[name.replace(/^.*::/, '')] ?? selectTables?.globalTypes?.[name];
  return !!t && /\[/.test(t);
}

/**
 * X names storage whose address stays put while the code runs: a local array, a local or
 * parameter pointer that nothing in `within` reassigns and whose address is not taken, or a
 * global the generator declares as an array.
 */
function fixedBase(fn: FunctionDecl, x: Expression, within: ASTNode[]): boolean {
  x = unparen(x);
  if (x.kind !== NodeKind.Identifier && x.kind !== NodeKind.QualifiedId) return false;
  const name = emit(x as never).replace(/\s+/g, '');
  if (!localNames(fn).has(name)) return globalArray(name);
  if (addressTaken(fn, name)) return false;
  for (const w of within) for (const { node } of walk(w)) {
    if (node.kind === NodeKind.AssignExpr && isId(unparen((node as AssignExpr).left), name)) return false;
    if ((node.kind === NodeKind.PostfixExpr || (node.kind === NodeKind.UnaryExpr && ['++', '--'].includes((node as UnaryExpr).operator)))
      && isId(unparen((node as UnaryExpr).operand), name)) return false;
  }
  return true;
}

/** `&*N` is N and `(N)` is N: what a pointer local reads back as after a rewrite through it. */
function tidyThrough(fn: FunctionDecl, n: string): void {
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot || node.kind !== NodeKind.UnaryExpr || (node as UnaryExpr).operator !== '&') continue;
    const o = unparen((node as UnaryExpr).operand);
    if (o.kind === NodeKind.UnaryExpr && (o as UnaryExpr).operator === '*' && isId(unparen((o as UnaryExpr).operand), n)) put(slot, { kind: NodeKind.Identifier, name: n } as Identifier);
  }
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (slot && node.kind === NodeKind.ParenExpr && isId(unparen(node as Expression), n)) put(slot, { kind: NodeKind.Identifier, name: n } as Identifier);
  }
}

/** Every X[i] under the nodes reads through n: `*n`, `X[i].m` as `n->m`. Returns how many. */
function readThrough(roots: ASTNode[], isSub: (x: ASTNode) => boolean, n: string): number {
  let k = 0;
  for (const w of roots) for (const { node, slot } of [...walk(w)]) {
    if (!slot || !isSub(node)) continue;
    const owner = !Array.isArray(slot.parent) ? (slot.parent as unknown as ASTNode) : undefined;
    const id = { kind: NodeKind.Identifier, name: n } as Identifier;
    if (owner && owner.kind === NodeKind.MemberExpr && slot.key === 'object' && !(owner as unknown as { isArrow: boolean }).isArrow) {
      (owner as unknown as { object: Expression }).object = id;
      (owner as unknown as { isArrow: boolean }).isArrow = true;
    } else put(slot, { kind: NodeKind.UnaryExpr, operator: '*', operand: id } as unknown as UnaryExpr);
    k++;
  }
  return k;
}

/**
 * ptrwalk(i,X,N,T[,k]): the for loop counting i up by one from A, whose body or condition
 * reads X[i], walks a pointer instead: `T *N = &X[A];` before the loop, every X[i] in the
 * condition and body reads through N (`*N`, `N->m`, `&X[i]` is N), and N steps with i
 * (`i++, N++`). N equals &X[i] wherever the loop evaluates either: only the increment
 * changes i, and X's storage stays put (fixedBase). The counter stays, so whatever else
 * reads i reads the same values.
 */
function doPtrwalk(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'ptrwalk' }>): void {
  const { counter: i, name: n } = f;
  if (localNames(fn).has(n) || mentions(fn.body!, n)) refuse(`${n} exists`);
  const isX = (e: Expression) => text(e) === norm(f.array);
  const isSub = (x: ASTNode) => x.kind === NodeKind.SubscriptExpr && isX(unparen((x as SubscriptExpr).array)) && isId(unparen((x as SubscriptExpr).index), i);
  const sites: Array<{ b: CompoundStmt; k: number; loop: ForStmt; start: Expression }> = [];
  for (const b of blocks(fn)) b.statements.forEach((s, k) => {
    if (s.kind !== NodeKind.ForStmt) return;
    const loop = s as ForStmt;
    let start: Expression | undefined;
    if (loop.init) {
      const st = storeOf(loop.init);
      if (st && st.operator === '=' && isId(unparen(st.left), i)) start = st.right;
      const d = declOf(loop.init);
      if (d && d.name.name === i && d.initializer) start = d.initializer as Expression;
    }
    if (!start || !loop.increment || !steps(loop.increment, i, '+')) return;
    const reads = [...walk(loop.body)].some(x => isSub(x.node)) || (!!loop.condition && [...walk(loop.condition)].some(x => isSub(x.node)));
    if (reads) sites.push({ b, k, loop, start });
  });
  const hit = f.index === 0 ? (sites.length === 1 ? sites[0] : refuse(`${sites.length} loops count ${i} over ${f.array}`))
    : (sites[f.index - 1] ?? refuse(`no loop #${f.index} counts ${i} over ${f.array}`));
  const { loop, start } = hit;
  const inside: ASTNode[] = [loop.body, ...(loop.condition ? [loop.condition] : [])];
  for (const w of inside) if (storedNames(w).has(i)) refuse(`${i} is stored in the loop`);
  if (addressTaken(fn, i)) refuse(`${i}'s address is taken`);
  const xNode = [...walk(loop)].find(x => isSub(x.node))!.node as SubscriptExpr;
  if (!fixedBase(fn, xNode.array, [loop])) refuse(`${f.array} is not storage that stays put`);
  // The start is evaluated once more, before the loop: a constant, or a name the init does not store.
  const s0 = unparen(start);
  if (!(s0.kind === NodeKind.IntegerLiteral || (isId(s0) && s0.name !== i))) refuse('the start is not a constant or a name');
  if (readThrough(inside, isSub, n) === 0) refuse(`no ${f.array}[${i}] in the loop`);
  tidyThrough(fn, n);
  const decl = (parse(`void __vc8f() { ${f.type}* ${n} = &${emit(xNode.array as never)}[${emit(start as never)}]; }`).declarations[0] as FunctionDecl).body!.statements[0];
  loop.increment = parseExpr(`${emit(loop.increment as never)}, ${n}++`);
  hit.b.statements.splice(hit.k, 0, decl);
}

/**
 * rowptr(X[I],N,T[,@A]): the row X[I] is read through a pointer local, `T *N = &X[I];`, as
 * `cache(&X[I],N,T*)` writes it: `X[I].m` reads `N->m`, `X[I]` reads `*N`. A table Ghidra
 * typed flat, read as `X[I + k]`, reads `N[k]`: the same element, `X[I + k]` is `(&X[I])[k]`.
 * X must stay put (fixedBase); cache refuses when X or a name in I is stored before the
 * last read it moves.
 */
function doRowptr(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'rowptr' }>): void {
  const row = parseExpr(f.expr);
  if (row.kind !== NodeKind.SubscriptExpr) refuse(`${f.expr} is no subscript`);
  const xText = text((row as SubscriptExpr).array), iText = text((row as SubscriptExpr).index);
  // The row's base as the body prints it (the tag's text may carry qualifiers the body drops).
  const base = [...walk(fn.body!)].find(x => x.node.kind === NodeKind.SubscriptExpr && text((x.node as SubscriptExpr).array) === xText);
  if (!base || !fixedBase(fn, (base.node as SubscriptExpr).array, [fn.body!])) refuse(`${f.expr} is not in storage that stays put`);
  for (const { node, slot } of [...walk(fn.body!)]) {
    if (!slot || node.kind !== NodeKind.SubscriptExpr) continue;
    const sub = node as SubscriptExpr;
    if (text(sub.array) !== xText) continue;
    const ix = unparen(sub.index);
    if (ix.kind !== NodeKind.BinaryExpr || (ix as BinaryExpr).operator !== '+') continue;
    const l = (ix as BinaryExpr).left, r = (ix as BinaryExpr).right;
    const pick = text(l) === iText && intValue(r) !== undefined ? [l, r] : text(r) === iText && intValue(l) !== undefined ? [r, l] : undefined;
    if (!pick) continue;
    const addr = { kind: NodeKind.UnaryExpr, operator: '&', operand: { kind: NodeKind.SubscriptExpr, array: sub.array, index: pick[0] } };
    put(slot, { kind: NodeKind.SubscriptExpr, array: { kind: NodeKind.ParenExpr, expression: addr }, index: pick[1] } as unknown as SubscriptExpr);
  }
  doCache(fn, { op: 'cache', expr: `&${f.expr}`, name: f.name, type: `${f.type}*`, ...(f.anchor ? { anchor: f.anchor } : {}) });
  tidyThrough(fn, f.name);
}

// ---------------------------------------------------------------------------------------
// acc: a unit field read through its accessor's inline twin

/** The definitions the form being applied calls (acc), reported with the site. */
let prefixUsed: Set<string> = new Set();

/** `X->a.b`: the pointer X and the field path, when e is such a read. */
function fieldRead(e: Expression): { base: Expression; path: string[] } | undefined {
  const path: string[] = [];
  let cur = unparen(e);
  while (cur.kind === NodeKind.MemberExpr) {
    const m = cur as unknown as { object: Expression; member: ASTNode; isArrow: boolean };
    if (!isId(m.member)) return undefined;
    path.unshift(m.member.name);
    if (m.isArrow) return { base: m.object, path };
    cur = unparen(m.object);
  }
  return undefined;
}

/** A pointer expression that reads only names and members: evaluated once or twice, the same. */
function plainPointer(e: Expression): boolean {
  const x = unparen(e);
  if (isId(x)) return true;
  if (x.kind === NodeKind.MemberExpr) return plainPointer((x as unknown as { object: Expression }).object);
  return false;
}

/** The integer a constant expression stands for: a literal, its negation, an enumerator, a cast of one. */
function constValue(e: Expression): bigint | undefined {
  const x = unparen(e);
  if (x.kind === NodeKind.IntegerLiteral) return (x as IntegerLiteralExpr).value as bigint;
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
    const v = constValue((x as UnaryExpr).operand);
    return v === undefined ? undefined : -v;
  }
  if (x.kind === NodeKind.CStyleCastExpr) return constValue((x as CStyleCastExpr).expression);
  if (isId(x)) {
    const v = selectTables?.enumValues?.[x.name];
    return v === undefined ? undefined : BigInt(v);
  }
  if (x.kind === NodeKind.QualifiedId) {
    const leaf = emit(x as never).split('::').pop()!.trim();
    const v = selectTables?.enumValues?.[leaf];
    return v === undefined ? undefined : BigInt(v);
  }
  return undefined;
}

/** 'set' when c is true exactly when p is not null, 'null' when exactly when it is. */
function nullTest(c: Expression, p: string): 'set' | 'null' | undefined {
  const x = unparen(c);
  if (text(x) === p) return 'set';
  if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '!' && text(unparen((x as UnaryExpr).operand)) === p) return 'null';
  if (x.kind === NodeKind.BinaryExpr && ['==', '!='].includes((x as BinaryExpr).operator)) {
    const b = x as BinaryExpr;
    const [v, k] = text(unparen(b.left)) === p ? [b.left, b.right] : text(unparen(b.right)) === p ? [b.right, b.left] : [];
    if (!v || !k) return undefined;
    const kk = unparen(k);
    const zero = constValue(kk) === 0n || (isId(kk) && ['nullptr', 'NULL'].includes(kk.name)) || kk.kind === NodeKind.NullptrLiteral;
    if (!zero) return undefined;
    return b.operator === '!=' ? 'set' : 'null';
  }
  return undefined;
}

/** Put n where child sits in parent. */
function replaceChild(parent: ASTNode, child: ASTNode, n: ASTNode): void {
  const o = parent as unknown as Record<string, unknown>;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (v === child) { o[k] = n; return; }
    if (Array.isArray(v)) { const i = v.indexOf(child); if (i >= 0) { v[i] = n; return; } }
  }
  refuse('internal: site not found under its parent');
}

function doAcc(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'acc' }>): void {
  const table = (selectTables as Vc8FormTables | undefined)?.accessors;
  if (!table?.length) refuse('no accessor table');
  const site = pick(fn, f.expr, f.index, (n): n is Expression => n.kind === NodeKind.MemberExpr && !!fieldRead(n as Expression));
  const read = fieldRead(site)!;
  const acc = table!.find(a => a.path.join('.') === read.path.join('.')) ?? refuse(`no accessor reads ${read.path.join('.')}`);
  if (!plainPointer(read.base)) refuse(`${emit(read.base as never)} is not a plain pointer`);
  const tables = selectTables;
  const shapeOf = createExprShape(localTypesOf(fn), {
    globalTypes: tables?.globalTypes ?? {}, enclosingVarTypes: tables?.enclosingVarTypes ?? {},
    structFields: tables?.structFields ?? {}, fieldTypes: tables?.fieldTypes ?? {},
    returnTypes: tables?.functionReturnTypes ?? {}, resolve: (n: string) => tables?.typedefTargets?.[n],
  });
  const shape = shapeOf(read.base);
  const base = shape?.base.replace(/^(?:struct\s+)?(?:::)?/, '').split('::').pop();
  if (!shape || shape.stars !== 1 || base !== acc.struct) refuse(`${emit(read.base as never)} is not a ${acc.struct} *`);
  const p = text(read.base);
  const call = { kind: NodeKind.CallExpr, callee: { kind: NodeKind.Identifier, name: acc.call }, arguments: [cloneNode(read.base)] } as unknown as Expression;

  const parents = parentsOf(fn);
  const up = (n: ASTNode): ASTNode => { let c = n; while (parents.get(c)?.kind === NodeKind.ParenExpr) c = parents.get(c)!; return c; };
  const at = up(site);
  const parent = parents.get(at);
  // `X ? X->F : K` and `!X ? K : X->F`: the accessor itself.
  if (parent?.kind === NodeKind.ConditionalExpr && !f.bare) {
    const c = parent as ConditionalExpr;
    const t = nullTest(c.condition, p);
    const other = t === 'set' && unparen(c.thenExpr) === unparen(at as Expression) ? c.elseExpr
      : t === 'null' && unparen(c.elseExpr) === unparen(at as Expression) ? c.thenExpr : undefined;
    if (other && constValue(other) === acc.dflt) {
      const top = up(parent);
      replaceChild(parents.get(top)!, top, call);
      prefixUsed.add(acc.definition);
      return;
    }
  }
  // `X && X->F == C` and `!X || X->F != C`: the null test goes where K gives its truth.
  if (parent?.kind === NodeKind.BinaryExpr && ['==', '!='].includes((parent as BinaryExpr).operator) && !f.bare) {
    const cmp = parent as BinaryExpr;
    const k = constValue(unparen(cmp.left) === unparen(at as Expression) ? cmp.right : cmp.left);
    const cmpAt = up(cmp);
    const q = parents.get(cmpAt);
    if (k !== undefined && k !== acc.dflt && q?.kind === NodeKind.BinaryExpr && (q as BinaryExpr).right === cmpAt) {
      const and = q as BinaryExpr;
      const want = and.operator === '&&' && cmp.operator === '==' ? 'set' : and.operator === '||' && cmp.operator === '!=' ? 'null' : undefined;
      if (want) {
        const l = unparen(and.left);
        if (nullTest(l, p) === want) {
          replaceChild(cmp, at, call);
          const top = up(and);
          replaceChild(parents.get(top)!, top, cmpAt);
          prefixUsed.add(acc.definition);
          return;
        }
        if (l.kind === NodeKind.BinaryExpr && (l as BinaryExpr).operator === and.operator && nullTest((l as BinaryExpr).right, p) === want) {
          replaceChild(cmp, at, call);
          and.left = (l as BinaryExpr).left;
          prefixUsed.add(acc.definition);
          return;
        }
      }
    }
  }
  replaceChild(parent ?? refuse('the read has no parent'), at, call);
  prefixUsed.add(acc.definition);
}

// ---------------------------------------------------------------------------------------
// retvar, onecall: a value VC8 held in a register, written as a variable of its own

/** Statements parsed from text, in a function of their own. */
function parseStmts(t: string): Statement[] {
  const fn = parse(`void __vc8f() { ${t} }`).declarations[0] as FunctionDecl;
  return fn.body!.statements;
}

/** Whether a statement can leave by a return or a goto (a loop's break stays inside). */
function returnsInside(s: Statement): boolean {
  for (const { node } of walk(s)) if (node.kind === NodeKind.ReturnStmt || node.kind === NodeKind.GotoStmt) return true;
  return false;
}

function freshName(fn: FunctionDecl, n: string): void {
  if (localNames(fn).has(n) || mentions(fn.body!, n)) refuse(`${n} names something already`);
}

function doRetvar(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'retvar' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (b !== fn.body) refuse('the if is not in the function\'s own block');
  const arm = stmtsOf(s.thenBranch);
  const last = arm[arm.length - 1] as ReturnStmt | undefined;
  if (!last || last.kind !== NodeKind.ReturnStmt || !last.value) refuse('the arm does not end in a return of a value');
  if (arm.slice(0, -1).some(returnsInside)) refuse('the arm leaves elsewhere too');
  const tail = b.statements[k + 1] as ReturnStmt | undefined;
  if (k + 2 !== b.statements.length || !tail || tail.kind !== NodeKind.ReturnStmt || !tail.value) refuse('the if is not followed by the function\'s last return');
  if (constValue(tail.value!) === undefined || !loadsNothing(tail.value!)) refuse(`${emit(tail.value as never)} is not a constant`);
  const type = emit(fn.returnType as never).trim();
  if (type === 'void') refuse('the function returns nothing');
  freshName(fn, f.name);
  const [decl] = parseStmts(`${type} ${f.name} = ${emit(tail.value as never)};`);
  const [store, ret] = parseStmts(`${f.name} = __vc8value; return ${f.name};`);
  ((store as ExprStmt).expression as AssignExpr).right = last.value!;
  arm[arm.length - 1] = store;
  s.thenBranch = asBlock(s.thenBranch);
  (s.thenBranch as CompoundStmt).statements = arm;
  b.statements.splice(k + 1, 1, ret);
  b.statements.splice(k, 0, decl);
}

/** The call an expression statement makes. */
function callOf(st: Statement | undefined): CallExpr | undefined {
  if (!st || st.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((st as ExprStmt).expression);
  return e.kind === NodeKind.CallExpr ? e as CallExpr : undefined;
}

function doOnecall(fn: FunctionDecl, f: Extract<Vc8Form, { op: 'onecall' }>): void {
  const { b, k, s } = nthIf(fn, f.cond, f.index);
  if (b !== fn.body) refuse('the if is not in the function\'s own block');
  const arm = stmtsOf(s.thenBranch);
  const first = callOf(arm[0]);
  if (arm.length !== 2 || !first || arm[1].kind !== NodeKind.ReturnStmt || (arm[1] as ReturnStmt).value) refuse('the arm is not a call and `return;`');
  const rest = b.statements.slice(k + 1);
  const second = callOf(rest[0]);
  if (!second || rest.length > 2 || (rest.length === 2 && (rest[1].kind !== NodeKind.ReturnStmt || (rest[1] as ReturnStmt).value))) {
    refuse('the if is not followed by the function\'s last call');
  }
  if (text(first.callee) !== text(second!.callee) || first.arguments.length !== second!.arguments.length) refuse('the two calls differ in callee or arity');
  const differ = first.arguments.map((a, j) => (text(a) === text(second!.arguments[j]) ? -1 : j)).filter(j => j >= 0);
  if (differ.length !== 1) refuse(`the calls differ in ${differ.length} arguments`);
  const j = differ[0];
  for (const [x, a] of first.arguments.entries()) if (x !== j && !loadsNothing(a)) refuse(`${emit(a as never)} loads or calls`);
  for (const v of [first.arguments[j], second!.arguments[j]]) {
    if (hasCall(v) || storedNames(v).size > 0) refuse(`${emit(v as never)} calls or stores`);
  }
  const name = calleeName(first.callee);
  const params = name && selectTables?.functionParamTypes
    ? scopedLookup(selectTables.functionParamTypes, name, selectTables.enclosingSegments ?? []) : undefined;
  const type = params?.[j];
  if (!type) refuse(`no parameter type for argument ${j + 1} of ${name ?? emit(first.callee as never)}`);
  freshName(fn, f.name);
  const [decl, sel] = parseStmts(`${type} ${f.name}; if (__vc8c) { ${f.name} = __vc8a; } else { ${f.name} = __vc8b; }`);
  const ifs = sel as IfStmt;
  ifs.condition = s.condition;
  (((ifs.thenBranch as CompoundStmt).statements[0] as ExprStmt).expression as AssignExpr).right = first.arguments[j];
  (((ifs.elseBranch as CompoundStmt).statements[0] as ExprStmt).expression as AssignExpr).right = second!.arguments[j];
  second!.arguments[j] = { kind: NodeKind.Identifier, name: f.name } as unknown as Expression;
  b.statements.splice(k, 1, decl, ifs);
}

const APPLY: { [K in Vc8Form['op']]: (fn: FunctionDecl, f: Extract<Vc8Form, { op: K }>) => void } = {
  seq: doSeq, fold: doFold, cache: doCache, own: doOwn, guards: doGuards, 'merge-guards': doMergeGuards,
  retval: doRetval, width: doWidth, boolflag: doBoolflag, retwiden: doRetwiden, arms: doArms,
  nest: doNest, 'merge-tail': doMergeTail, continue: doContinue, dup: doDup, tarms: doTarms, zero: doZero, nonzero: doNonzero, bool: doBool,
  cmp: doCmp, swap: doSwap, ifsel: doIfsel, split: doSplit, select: doSelect, decl: doDecl, unselect: doUnselect,
  tsel: doTsel, hoist: doHoist, nestcall: doNestcall, fill: doFill, copy: doCopy, shift: doShift, ptrwalk: doPtrwalk, rowptr: doRowptr,
  acc: doAcc,
  retvar: doRetvar, onecall: doOnecall,
};

/**
 * Apply the forms to the (single) function definition in tu, in order. Each form works on
 * a copy and is kept only when it applied whole.
 */
/**
 * A form's expressions in the spelling the body now has. seed-roll-step turns a seed
 * temporary `X` from a D2SeedStrc into the uint32_t low word it reads (`X.nSeedLow` becomes
 * `X`); a tag recorded before that names `X.nSeedLow`, which nothing prints any more
 * (AITHINK_Fn1_Arach 005f4510's `nest((int)(DVar1.nSeedLow % 100) >= ...)`). Where X is a
 * local of the function no longer declared D2SeedStrc, the member is read as X itself -
 * the same word the rewrite made X hold.
 */
function respellForm(fn: FunctionDecl, form: Vc8Form): Vc8Form {
  const words = new Set<string>();
  for (const { node } of walk(fn.body!)) {
    if (node.kind !== NodeKind.VariableDecl) continue;
    const d = node as VariableDecl;
    if (!/\bD2SeedStrc\b/.test(text(d.type))) words.add(d.name.name);
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(form)) {
    if (k === 'op' || typeof v !== 'string') { out[k] = v; continue; }
    const r = v.replace(/\b([A-Za-z_]\w*)\s*\.\s*nSeedLow\b/g, (m, x: string) => (words.has(x) ? x : m));
    if (r !== v) changed = true;
    out[k] = r;
  }
  return changed ? (out as unknown as Vc8Form) : form;
}

export function applyVc8Forms(tu: TranslationUnit, forms: Array<{ form: Vc8Form; tag?: string }>,
  onSite?: (s: Vc8FormSite) => void, tables?: Vc8FormTables): TranslationUnit {
  if (forms.length === 0) return tu;
  selectTables = tables;
  let cur = tu;
  for (const { form, tag } of forms) {
    const next = cloneNode(cur);
    const fn = next.declarations.find(d => d.kind === NodeKind.FunctionDecl && (d as FunctionDecl).body) as FunctionDecl | undefined;
    prefixUsed = new Set();
    try {
      if (!fn) refuse('no function body');
      (APPLY[form.op] as (fn: FunctionDecl, f: Vc8Form) => void)(fn!, respellForm(fn!, form));
      cur = next;
      onSite?.({ form, tag, applied: true, ...(prefixUsed.size ? { prefix: [...prefixUsed] } : {}) });
    } catch (e) {
      if (!(e instanceof Refuse)) throw e;
      onSite?.({ form, tag, applied: false, why: e.message });
    }
  }
  return cur;
}

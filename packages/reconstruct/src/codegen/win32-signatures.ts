/**
 * Parameter types Ghidra already knows for the imported SDK functions, read off
 * the decompiler's own argument annotations.
 *
 * The database has no `Function` record for `FindFirstFileW`, `ReadFile` or
 * `CopyRect` — they are import thunks, not code — so every name-keyed signature
 * table in the emitter misses them, and a call argument crosses into a Win32
 * slot with no declared type to be cast to. Ghidra nevertheless knows those
 * prototypes: it applies its Windows type archive to the import and then writes
 * one annotation per pushed argument into the pseudo-C it emits,
 *
 *     /* LPWIN32_FIND_DATAW lpFindFileData for FindFirstFileW *\/
 *     /* LPCWSTR lpFileName for FindFirstFileW *\/
 *     hFind = FindFirstFileW(wszPath,&findData);
 *
 * in reverse (push) order. That is the SDK header's own prototype, which is
 * exactly the record `platformDeclaredFunctionNames()` exists to defer to — so
 * unlike Ghidra's `Function` record for a CRT name, it cannot disagree with the
 * declaration the compiler will see.
 *
 * The annotations come in fragments: Ghidra writes one only where the argument's
 * PUSH sits next to the call, so a site may annotate all six parameters, or the
 * middle two, or one. Fragments are merged by taking the longest and requiring
 * every other fragment to be a subsequence of it; a callee whose fragments
 * disagree is dropped rather than guessed at.
 *
 * The result is consumed as `pointerOnlyParamTypes`, and that name is the whole
 * safety argument: a slot from this table is only ever cast into when BOTH the
 * declared parameter and the argument are pointers. `int -> LPCSTR` is a real
 * defect — those integers hold packed inline string data, `0x73257325` is `"%s%s"`
 * sitting in an immediate — and a cast there compiles into a wild pointer. The
 * pointer-to-pointer rule excludes it by construction rather than by exception.
 */

import type { ExtractedFunction } from '../types.js';

/** `/(*) <TYPE> <name> for <Callee> (*)/` on a line of its own. */
const ANNOTATION = /^\s*\/\*\s+(.+?)\s+for\s+([A-Za-z_][A-Za-z0-9_]*)\s+\*\/\s*$/;

/**
 * Split a `TYPE name` declarator. The stars bind to the name in Ghidra's
 * spelling (`char *pszText`), so they move back onto the type.
 */
function splitDeclarator(decl: string): { type: string; name: string } | undefined {
  const m = /^(.*?)([A-Za-z_]\w*)$/.exec(decl.trim());
  if (!m) return undefined;
  const [, lead, name] = m;
  const type = lead.trim();
  if (!type || !/^[A-Za-z_]/.test(type)) return undefined;
  return { type, name };
}

/** Is `sub` a subsequence of `full`, comparing declarator spellings? */
function isSubsequence(sub: readonly string[], full: readonly string[]): boolean {
  let i = 0;
  for (const s of full) {
    if (i < sub.length && sub[i] === s) i++;
  }
  return i === sub.length;
}

/**
 * Harvest, per callee, the parameter type spellings in declaration order.
 *
 * `claimedByModel` are names the database has its own function record for. A
 * name it knows is answered by the ordinary signature tables — and where those
 * dropped it because two overloads disagreed, that disagreement must not be
 * papered over from here.
 */
export function harvestAnnotatedParameterTypes(
  functions: readonly ExtractedFunction[],
  claimedByModel: ReadonlySet<string>,
): Record<string, string[]> {
  /** callee → distinct fragment (declarator spellings, declaration order) → seen */
  const fragments = new Map<string, Map<string, string[]>>();

  const record = (callee: string | undefined, run: string[]): void => {
    if (!callee || run.length === 0) return;
    const ordered = [...run].reverse();
    let byKey = fragments.get(callee);
    if (!byKey) { byKey = new Map(); fragments.set(callee, byKey); }
    byKey.set(ordered.join('|'), ordered);
  };

  for (const fn of functions) {
    const body = fn.decompiled;
    if (!body || !body.includes(' for ')) continue;
    let run: string[] = [];
    let callee: string | undefined;
    let namesInRun = new Set<string>();
    for (const line of body.split('\n')) {
      const m = ANNOTATION.exec(line);
      if (!m) {
        record(callee, run);
        run = []; callee = undefined; namesInRun = new Set();
        continue;
      }
      const [, decl, name] = m;
      const parts = splitDeclarator(decl);
      if (!parts) {
        record(callee, run);
        run = []; callee = undefined; namesInRun = new Set();
        continue;
      }
      // A parameter name repeating, or the callee changing, starts a new call:
      // two adjacent calls to one function annotate back to back otherwise, and
      // the two runs would merge into one impossible signature.
      if (name !== callee || namesInRun.has(parts.name)) {
        record(callee, run);
        run = []; callee = name; namesInRun = new Set();
      }
      run.push(decl.trim());
      namesInRun.add(parts.name);
    }
    record(callee, run);
  }

  const out: Record<string, string[]> = {};
  for (const [callee, byKey] of fragments) {
    if (claimedByModel.has(callee)) continue;
    const variants = [...byKey.values()];
    let longest = variants[0];
    for (const v of variants) if (v.length > longest.length) longest = v;
    if (!variants.every(v => isSubsequence(v, longest))) continue;
    const types: string[] = [];
    let ok = true;
    for (const decl of longest) {
      const parts = splitDeclarator(decl);
      if (!parts) { ok = false; break; }
      types.push(parts.type);
    }
    if (ok) out[callee] = types;
  }
  return out;
}

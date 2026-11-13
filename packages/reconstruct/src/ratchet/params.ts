/**
 * Which parameter of a function's current signature a parameter of an older one became.
 *
 * Ghidra can re-order a function's parameters (1165: the register parameters of 25 static
 * callees, storage unchanged). Position then means nothing: a stored body that names its
 * second parameter must name whatever the value in that parameter's storage is called now,
 * and a stored call must pass each argument to the parameter it was passed to before.
 *
 * A parameter's identity is its storage (`ECX:4`, `Stack[0x8]:4`) and its name. Storage is
 * what the original binary fixes, so it decides where both are known; the name decides where
 * storage is not known (a record captured before maps carried storage) or changed. A stack
 * slot is an identity only while the stack layout is the same on both sides: a register
 * parameter that moved to the stack shifts every slot after it without re-ordering
 * anything. Where storage and name disagree - the value in ECX was called `nX` and now `nX`
 * is the parameter in EDX - the edit could be a re-order or a correction of which name sits on which storage, and nothing
 * here can tell them apart: that is reported, never guessed. A parameter that kept neither
 * its storage nor its name keeps its position, but only when that position is not claimed
 * by another parameter's identity.
 */

export interface ParamId {
  name: string;
  /** Ghidra's storage, when known. */
  storage?: string;
}

export type ParamMatch = { map: number[] } | { error: string };

/** Zip names with storage; storage only when there is one per name. */
export function paramIds(names: readonly string[], storage?: readonly string[]): ParamId[] {
  const s = storage && storage.length === names.length ? storage : undefined;
  return names.map((name, k) => (s?.[k] ? { name, storage: s[k] } : { name }));
}

function distinct(values: Array<string | undefined>): boolean {
  return values.every(v => !!v) && new Set(values).size === values.length;
}

function isStack(storage: string): boolean {
  return storage.startsWith('Stack[');
}

function show(p: ParamId): string {
  return p.storage ? `${p.name || '?'}@${p.storage}` : p.name || '?';
}

/**
 * `map[i]` is the index in `after` of `before[i]`. Both lists must be the same length: a
 * parameter that appeared or went is not a re-order.
 */
export function matchParams(before: readonly ParamId[], after: readonly ParamId[]): ParamMatch {
  if (before.length !== after.length) return { error: `arity changed: ${before.length} -> ${after.length} parameters` };
  const n = before.length;
  const byStorage = distinct(before.map(p => p.storage)) && distinct(after.map(p => p.storage));
  const byName = distinct(before.map(p => p.name)) && distinct(after.map(p => p.name));
  const slots = (l: readonly ParamId[]) => l.map(p => p.storage!).filter(isStack).sort().join(',');
  const sameStack = byStorage && slots(before) === slots(after);
  const map: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const st = before[i].storage;
    const js = byStorage && (sameStack || !isStack(st!)) ? after.findIndex(q => q.storage === st) : -1;
    const jn = byName ? after.findIndex(q => q.name === before[i].name) : -1;
    if (js >= 0 && jn >= 0 && js !== jn) {
      return { error: `parameter ${show(before[i])} is ambiguous: its storage is ${show(after[js])} now, its name ${show(after[jn])}` };
    }
    map[i] = js >= 0 ? js : jn;
  }
  // Neither storage nor name found: the position, when no other identity claims it.
  const claimed = new Set(map.filter(j => j >= 0));
  for (let i = 0; i < n; i++) {
    if (map[i] >= 0) continue;
    if (claimed.has(i)) return { error: `parameter ${show(before[i])} kept neither its storage nor its name, and its position is ${show(after[i])}'s now` };
    map[i] = i;
    claimed.add(i);
  }
  if (new Set(map).size !== n) return { error: `parameters ${before.map(show).join(', ')} -> ${after.map(show).join(', ')} do not pair one to one` };
  return { map };
}

export function isIdentity(map: readonly number[]): boolean {
  return map.every((j, i) => j === i);
}

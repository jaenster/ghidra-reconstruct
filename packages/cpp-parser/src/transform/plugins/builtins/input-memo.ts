/**
 * Derivations from the per-run tables, computed once per run instead of once
 * per function.
 *
 * A pass's transformer is created for every function, but the whole-program
 * tables it is handed (global addresses, sizes, enum values...) are the same
 * objects for every function of a run. An index a factory builds from them is
 * therefore the same index every time; rebuilding it per function made the
 * factories the largest cost of generation (a 10k-entry scan times 13k
 * functions, several passes over).
 */

/** The last derivation made at one call site, and the inputs it was made from. */
export interface MemoSlot<R> {
  inputs?: readonly unknown[];
  value?: R;
}

/**
 * `build()`, or the value it returned last time at this slot when every input
 * is the identical object (or primitive) it was then. An input that is a fresh
 * object each call - an `?? {}` default - simply never hits, which is correct.
 *
 * The derived value is shared by every later caller: treat it as read-only.
 */
export function memoOnInputs<R>(slot: MemoSlot<R>, inputs: readonly unknown[], build: () => R): R {
  const prev = slot.inputs;
  if (prev && prev.length === inputs.length && prev.every((v, i) => v === inputs[i])) {
    return slot.value as R;
  }
  const value = build();
  slot.inputs = inputs;
  slot.value = value;
  return value;
}

const nonEmpty = new WeakMap<object, boolean>();

/**
 * `Object.keys(o).length > 0`, answered once per table object.
 *
 * Neither `Object.keys` nor `for...in` is cheap on a 14k-key table: V8 builds the
 * whole key list before yielding the first key, so even an early-exit loop costs
 * a full enumeration. Like the derivations above, this assumes the table is not
 * written once generation has started.
 */
export function hasOwnKeys(o: object | null | undefined): boolean {
  if (!o) return false;
  let hit = nonEmpty.get(o);
  if (hit === undefined) {
    hit = Object.keys(o).length > 0;
    nonEmpty.set(o, hit);
  }
  return hit;
}

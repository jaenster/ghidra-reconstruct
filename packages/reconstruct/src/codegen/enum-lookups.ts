/**
 * Enum member facts a body transform reads over the whole program, recorded per unit.
 *
 * `compare-form` keeps a bare enum member in a zero test when every enum that declares the
 * name gives it 0. That reads enums the function never names: a second enum gaining the
 * name, or changing its value, flips the decision without moving any input of the unit -
 * the unit has no dependency edge on either enum. While a sink is set (one unit's
 * emission, codegen/index.ts), each member name asked about is reported, so the unit
 * records the answer its text was written under and is not reused once it changes.
 */

type MemberValues = Record<string, Record<string, number>>;

let sink: ((name: string) => void) | null = null;

export function recordEnumLookups(next: ((name: string) => void) | null): void {
  sink = next;
}

const byTable = new WeakMap<MemberValues, Map<string, string>>();

/** Every value enums give the member `name`, distinct and sorted; '' when none declares it. */
export function enumMemberFact(values: MemberValues | undefined, name: string): string {
  if (!values) return '';
  let index = byTable.get(values);
  if (!index) {
    const sets = new Map<string, Set<number>>();
    for (const members of Object.values(values)) {
      for (const [n, v] of Object.entries(members)) {
        let set = sets.get(n);
        if (!set) sets.set(n, set = new Set());
        set.add(v);
      }
    }
    index = new Map([...sets].map(([n, s]) => [n, [...s].sort((a, b) => a - b).join(',')]));
    byTable.set(values, index);
  }
  return index.get(name) ?? '';
}

/** Whether every enum declaring `name` gives it 0, reported to the sink. */
export function zeroEnumMember(values: MemberValues | undefined): (name: string) => boolean {
  return name => {
    sink?.(name);
    return enumMemberFact(values, name) === '0';
  };
}

/**
 * Which objects carry a typed virtual function table, and what each slot takes.
 *
 * Ghidra prints a virtual call through an object it could not type as
 *
 *     (**(code **)(*(int *)pObj + 0x10))(nArg);
 *
 * and the `vtable-calls` pass keeps that shape when it knows nothing better. It
 * is not a faithful call: the machine loads the object into ECX before the
 * `CALL [reg+0x10]`, while the rebuilt slot function either takes that object as
 * its explicit first parameter (a `__thiscall` slot, emitted free) or is a
 * `__stdcall` body that pops its own arguments - and `code` is a variadic cdecl
 * type, so neither is called correctly through it.
 *
 * When the receiver's declared type is a class whose first word is a typed
 * vtable pointer, the call can be spelled through that table instead:
 *
 *     pObj->pVtable->OnMouseUp(pObj, nArg);
 *
 * which carries the slot's real signature, including the `this` a `__thiscall`
 * slot takes. These tables say, per class, where its vtable pointer sits and,
 * per vtable, what each slot is called and takes. Everything comes from the
 * types Ghidra holds; nothing is inferred from a name or a call's shape.
 */

import type { ExtractedDataType, ExtractedStruct, ExtractedFunctionDefinition } from '../types.js';

export interface VtableSlot {
  /** The vtable member, spelled as the header emits it. */
  member: string;
  /** Parameters the slot's funcdef declares, `this` included when it takes one. */
  arity: number;
  /** The funcdef is `__thiscall`: the emitted pointer type lists `this` first. */
  takesThis: boolean;
}

export interface VtableClass {
  /** Member path from the object to its vtable pointer: `['pVtable']`, or through embedded bases. */
  vfptrPath: string[];
  /** The vtable STRUCTURE the pointer is typed as. */
  vtable: string;
}

export interface VtableDispatchTables {
  /** Class (aggregate) name → where its vtable pointer is. */
  classes: Record<string, VtableClass>;
  /** Vtable name → byte offset → slot. */
  vtables: Record<string, Record<number, VtableSlot>>;
}

/** `T *`, `struct T *`, `::T *` → `T`; anything that is not exactly one pointer to a name → undefined. */
export function pointeeName(spelling: string | undefined): string | undefined {
  if (!spelling) return undefined;
  const s = spelling.replace(/\b(struct|class|const|volatile)\b/g, ' ').replace(/\s+/g, '');
  const m = s.match(/^(?:::)?([A-Za-z_][\w:]*)\*$/);
  return m ? m[1].replace(/^::/, '') : undefined;
}

/** `T`, `struct T` → `T` (an embedded aggregate, not a pointer). */
function aggregateName(spelling: string | undefined): string | undefined {
  if (!spelling) return undefined;
  const s = spelling.replace(/\b(struct|class|const|volatile)\b/g, ' ').replace(/\s+/g, '');
  return /^(?:::)?[A-Za-z_][\w:]*$/.test(s) ? s.replace(/^::/, '') : undefined;
}

/**
 * Build the dispatch tables.
 *
 * A vtable is a STRUCTURE every field of which points at a FUNCTION_DEFINITION.
 * Member names are the ones the header emits: a raw Ghidra name the emitter has
 * to respell (`super_TSHashTable<struct_CELLIST,class_HASHKEY_NONE>`) is taken
 * in its emitted form, and one it renames in some other way is not published.
 * A class is a STRUCTURE whose field at offset 0 points at such a vtable, or
 * embeds (at offset 0) a class that does - the single, non-virtual inheritance
 * every RTTI hierarchy in the binary uses.
 *
 * A slot is published only when its member name is unique in the vtable and is
 * a member the header actually emits under that name: a pure-virtual table
 * holds eleven fields all called `__purecall`, which the emitter has to rename,
 * and a guessed spelling would not compile.
 */
export function buildVtableDispatch(
  dataTypes: ReadonlyArray<ExtractedDataType>,
  funcDefs: ReadonlyArray<ExtractedFunctionDefinition>,
  emittedMembers: (dt: ExtractedDataType) => ReadonlySet<string> = () => new Set<string>(),
): VtableDispatchTables {
  const funcdefByName = new Map<string, ExtractedFunctionDefinition | null>();
  for (const fd of funcDefs) {
    if (!fd.name) continue;
    // Two funcdefs sharing a name (different categories) are no evidence about either.
    funcdefByName.set(fd.name, funcdefByName.has(fd.name) ? null : fd);
  }
  const funcdefOf = (spelling: string | undefined): ExtractedFunctionDefinition | undefined => {
    const name = pointeeName(spelling);
    if (!name) return undefined;
    return funcdefByName.get(name) ?? undefined;
  };

  const structs = new Map<string, ExtractedStruct | null>();
  for (const dt of dataTypes) {
    if (dt.kind !== 'STRUCTURE' || !dt.name) continue;
    structs.set(dt.name, structs.has(dt.name) ? null : (dt as ExtractedStruct));
  }

  const vtables: Record<string, Record<number, VtableSlot>> = {};
  for (const [name, st] of structs) {
    if (!st) continue;
    const fields = st.fields ?? [];
    if (fields.length === 0) continue;
    // Every field points at a funcdef - an ambiguous funcdef name still says "function
    // pointer", it only withholds that one slot's signature.
    if (!fields.every(f => funcdefByName.has(pointeeName(f.dataType) ?? ''))) continue;
    const counts = new Map<string, number>();
    for (const f of fields) if (f.name) counts.set(f.name, (counts.get(f.name) ?? 0) + 1);
    const emitted = emittedMembers(st);
    const slots: Record<number, VtableSlot> = {};
    for (const f of fields) {
      if (!f.name || counts.get(f.name) !== 1) continue;
      if (emitted.size > 0 && !emitted.has(f.name)) continue;
      const fd = funcdefOf(f.dataType);
      if (!fd || fd.hasVarArgs) continue;
      slots[f.offset] = {
        member: f.name,
        arity: (fd.parameters ?? []).length,
        takesThis: fd.callingConvention === '__thiscall',
      };
    }
    vtables[name] = slots;
  }

  /** The member name as the header emits it, or undefined when that cannot be told. */
  const emittedMember = (st: ExtractedStruct, raw: string): string | undefined => {
    const emitted = emittedMembers(st);
    if (emitted.size === 0 || emitted.has(raw)) return raw;
    const flat = raw.replace(/[^A-Za-z0-9_]/g, '_');
    return emitted.has(flat) ? flat : undefined;
  };

  const classes: Record<string, VtableClass> = {};
  const resolve = (name: string, seen: Set<string>): VtableClass | undefined => {
    if (classes[name]) return classes[name];
    if (seen.has(name)) return undefined;
    seen.add(name);
    const st = structs.get(name);
    if (!st) return undefined;
    const first = (st.fields ?? []).find(f => f.offset === 0);
    if (!first?.name) return undefined;
    const member = emittedMember(st, first.name);
    if (!member) return undefined;
    const target = pointeeName(first.dataType);
    if (target && vtables[target]) {
      return (classes[name] = { vfptrPath: [member], vtable: target });
    }
    const base = aggregateName(first.dataType);
    if (base) {
      const inner = resolve(base, seen);
      if (inner) return (classes[name] = { vfptrPath: [member, ...inner.vfptrPath], vtable: inner.vtable });
    }
    return undefined;
  };
  for (const name of structs.keys()) resolve(name, new Set());

  return { classes, vtables };
}

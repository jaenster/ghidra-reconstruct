/**
 * Checks about DATA INITIALIZERS: values written into an object before any code runs.
 */

import { NodeKind, type ASTNode } from '@ghidra-mcp/cpp-parser';
import {
  declName, elementType, innermostElement, isArrayType, isCast, isPointerType, line, signature, unparen, walk,
} from '../ast.js';
import type { Check, Finding, LintContext } from '../context.js';
import { fileScopeVars, type SourceFile } from '../tree.js';

/** The Windows image window: below the image base is a Ghidra placeholder, above 2 GB is unmapped. */
const IMAGE_FLOOR = 0x400000;
const IMAGE_CEILING = 0x80000000;

/** Whether a value lies inside the Windows image window. */
export const inImage = (v: number) => v >= IMAGE_FLOOR && v < IMAGE_CEILING;

/** An integer literal through parentheses only - a cast is the slot, not the value. */
export function literalValue(e: any): number | null {
  const s = unparen(e);
  if (s?.kind !== NodeKind.IntegerLiteral) return null;
  const v = s.value;
  return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;
}

/**
 * The raw address an initializer element puts into a pointer slot, or null.
 *
 * `(T *)0x0096c8c8` is a pointer slot by its own cast, wherever it sits. A bare literal is
 * one only where the declared type says so: the whole initializer of a pointer, or an element
 * of an array whose element type is a pointer.
 */
function pointerSlotLiteral(e: any, slotIsPointer: boolean): number | null {
  const s = unparen(e);
  if (isCast(s) && isPointerType(s.type)) return literalValue(s.expression);
  if (slotIsPointer) return literalValue(s);
  return null;
}

/** Every element of an initializer, with whether its slot is known to be a pointer. */
function* initializerSlots(init: any, type: any): Generator<{ node: any; slotIsPointer: boolean }> {
  if (!init) return;
  const u = unparen(init);
  if (u?.kind !== NodeKind.InitListExpr) {
    yield { node: u, slotIsPointer: isPointerType(type) };
    return;
  }
  // Brace elision lets a flat list fill a nested array, so a pointer element anywhere in an
  // array of pointers is a pointer slot. Inside a struct aggregate only the cast says so.
  const elemIsPointer = isArrayType(type) && isPointerType(innermostElement(type));
  const stack: Array<{ list: any; t: any }> = [{ list: u, t: type }];
  while (stack.length) {
    const { list, t } = stack.pop()!;
    const sub = isArrayType(t) ? elementType(t) : null;
    for (const raw of list.elements ?? []) {
      const el = raw?.kind === NodeKind.DesignatedInitExpr ? (raw.initializer ?? raw.value ?? raw.expression) : raw;
      const v = unparen(el);
      if (v?.kind === NodeKind.InitListExpr) stack.push({ list: v, t: sub });
      else yield { node: v, slotIsPointer: elemIsPointer || (!!sub && isPointerType(sub)) };
    }
  }
}

/** Every name the tree defines as data: namespace/file scope in any file, and static locals. */
export function definedDataNames(ctx: LintContext): Set<string> {
  const out = new Set<string>();
  for (const f of ctx.tree.files) for (const n of fileScopeVars(f).keys()) out.add(n);
  for (const fn of ctx.tree.functions) {
    for (const d of ctx.of(fn, NodeKind.VariableDecl)) {
      if ((d.specifiers ?? []).includes('static')) {
        const n = declName(d);
        if (n) out.add(n);
      }
    }
  }
  return out;
}

/**
 * The global a raw value names: the one Windows symbol starting at that address, provided its
 * name is carried by no other Windows symbol and the tree defines it. Null otherwise - an
 * interior address, an address two symbols share, or a name the generator cannot qualify.
 */
export function addressTargetResolver(ctx: LintContext): (v: number) => string | null {
  const snap = ctx.snapshot;
  if (!snap) return () => null;
  const byAddress = new Map<number, string[]>();
  const nameCount = new Map<string, number>();
  for (const g of snap.globals) {
    const l = byAddress.get(g.address);
    if (l) l.push(g.name); else byAddress.set(g.address, [g.name]);
    nameCount.set(g.name, (nameCount.get(g.name) ?? 0) + 1);
  }
  const defined = definedDataNames(ctx);
  return (v: number) => {
    if (!inImage(v)) return null;
    const names = byAddress.get(v);
    if (!names || names.length !== 1) return null;
    const target = names[0];
    return nameCount.get(target) === 1 && defined.has(target) ? target : null;
  };
}

/** `globals.cpp` / `globals.<Module>.cpp` at the tree root: the central data definitions. */
const isGlobalsImpl = (path: string) => /^globals(\.[^/]+)?\.cpp$/.test(path);

/**
 * A pointer initializer holding the ORIGINAL ADDRESS of a global the tree itself defines.
 *
 * `D2SeedStrc * psDataTableSeed = (D2SeedStrc *)0x0096c8c8;` compiles and links. In the
 * rebuilt image 0x0096c8c8 is not `gsAutoMapSeed` - it is whatever the new link put there, or
 * nothing - and the first write through the pointer faults at startup. The emitter resolves
 * such a literal to `&name` only for a target that is referenceable at the moment the
 * initializer table is built, so a target whose scope was wrong at that moment comes out raw
 * even when it ends up defined.
 *
 * Sites: every non-extern definition outside a function in `globals*.cpp`, and every static
 * local. The value must be the start address of exactly one Windows symbol in the snapshot,
 * that symbol's name must be unique among Windows symbols and defined somewhere in the tree,
 * and the object being initialised must itself be a Windows symbol in the image - a Mac
 * object's initializer holds a Mac address that may coincide with a Windows one.
 *
 * Not reported: a value naming a symbol whose NAME is shared by several Windows symbols. The
 * generator's address table is keyed by bare name and drops those on purpose (the RTTI
 * `vftable_meta_ptr = (void*)<RTTI_Complete_Object_Locator>` entries, one locator per class),
 * so they are a separate class - an unqualifiable reference, not a scope that was wrong.
 */
export const rawAddressInitializer: Check = {
  id: 'raw-address-initializer',
  blurb: "pointer initializer holds the original address of a global the tree defines",
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;

    const targetOf = addressTargetResolver(ctx);

    const check = (file: SourceFile, fnName: string | undefined, decl: any) => {
      if ((decl.specifiers ?? []).includes('extern') || !decl.initializer) return;
      const owner = declName(decl);
      if (!owner) return;
      const ownerSym = snap.globalByName.get(owner);
      if (!ownerSym || !inImage(ownerSym.address)) return;
      for (const { node, slotIsPointer } of initializerSlots(decl.initializer, decl.type)) {
        const v = pointerSlotLiteral(node, slotIsPointer);
        if (v === null) continue;
        const target = targetOf(v);
        if (!target) continue;
        out.push({
          check: this.id, file: file.path, line: line(node), fn: fnName, subject: owner,
          detail: `holds 0x${v.toString(16).padStart(8, '0')}, the original address of '${target}' - should be &${target}`,
          sig: signature(node),
        });
      }
    };

    for (const file of ctx.tree.files) {
      if (file.isHeader || !isGlobalsImpl(file.path)) continue;
      walk(file.tu as ASTNode, (n: any) => {
        if (n.kind === NodeKind.FunctionDecl) return 'skip';
        if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) return 'skip';
        if (n.kind === NodeKind.VariableDecl) check(file, undefined, n);
        return undefined;
      });
    }
    for (const fn of ctx.tree.functions) {
      if (fn.file.isHeader) continue;
      for (const d of ctx.of(fn, NodeKind.VariableDecl)) {
        if ((d.specifiers ?? []).includes('static')) check(fn.file, fn.qualifiedName, d);
      }
    }
    return out;
  },
};

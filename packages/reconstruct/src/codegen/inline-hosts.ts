/**
 * Functions the original compiled from a header: DLL-era inlines.
 *
 * Before 1.14d folded the DLLs into one image, a small helper defined in a shared
 * header (`TXT_MonStats_GetLine`, `GetGUID`, `SEED_RollRange`, Storm's
 * `operator delete` shim) was compiled into every module that called it. In the
 * single image one copy survives, at the place the first object in link order that
 * used it put it. Ghidra marks such a function with the tag `inline-host`; its
 * namespace is the unit that hosts the surviving copy.
 *
 * The rebuild gives every translation unit that names the function its definition,
 * as the original's header did, and lets the link keep one copy:
 *
 *  - the unit header declares it `__attribute__((noinline)) inline`
 *    (COMDAT_SPECIFIERS): `inline` because every calling TU defines it, `noinline`
 *    because the original kept a real call at every call site - each module's
 *    compiler emitted its own copy and called it, it never expanded the body;
 *  - the body is defined, with the same specifiers, in the unit's inline header
 *    (`<unit>.inline.h`), not in the unit's .cpp;
 *  - every file that names the function includes that header after its own
 *    includes are resolved, as it includes the header of any callee.
 *
 * The inline header is included by .cpp files only, never by another unit header:
 * its bodies need complete types and globals (`sgptDataTable->nTxtMonStatsSize`),
 * so it includes globals.h and the unit headers that define them, and globals.h
 * includes about a hundred unit headers for their types. Included from a unit
 * header, it would re-enter globals.h while one of those headers is half read.
 * Included by a .cpp, every header it pulls in is read from the top of the TU,
 * and another inline header it includes only needs the declarations its own unit
 * header gives it.
 *
 * A global such a body names is compiled into every calling TU, so it can be static
 * to none of them: the inline host is left out of the function-to-TU map the global
 * scopes are decided from, which keeps every global it names external.
 */

import type { ExtractedFunction } from '../types.js';
import { templateRegistry } from './templates/registry.js';

/** The Ghidra function tag that marks a header inline's surviving copy. */
export const INLINE_HOST_TAG = 'inline-host';

/** Whether Ghidra tags this function as a header inline's surviving copy. */
export function hasInlineHostTag(func: Pick<ExtractedFunction, 'tags'>): boolean {
  return func.tags?.some(t => t.type === INLINE_HOST_TAG) ?? false;
}

/**
 * Why a tagged function is not emitted as a header inline, or undefined when it is.
 * Only a plain free function is: a method, a template member, a thunk, a library or
 * platform-guarded function is declared and defined by its own machinery.
 */
export function inlineHostRefusal(
  func: Pick<ExtractedFunction, 'tags' | 'isThunk' | 'isExternal' | 'isLibrary' | 'parentClass' | 'ifdef' | 'platform' | 'namespace' | 'name'>,
): string | undefined {
  if (!hasInlineHostTag(func)) return 'not tagged';
  if (func.isExternal) return 'external';
  if (func.isThunk) return 'thunk';
  if (func.isLibrary) return 'library function';
  if (func.parentClass) return 'method';
  if (func.ifdef || func.platform) return 'platform-guarded';
  if (func.name.startsWith('operator') || func.name.startsWith('~')) return 'operator';
  const templates = templateRegistry();
  if (templates && (templates.isClassScope(func.namespace) || templates.elementOf(func.namespace))) return 'template member';
  return undefined;
}

/** Whether this function is emitted as a header inline (see the module comment). */
export function isInlineHost(
  func: Pick<ExtractedFunction, 'tags' | 'isThunk' | 'isExternal' | 'isLibrary' | 'parentClass' | 'ifdef' | 'platform' | 'namespace' | 'name'>,
): boolean {
  return hasInlineHostTag(func) && inlineHostRefusal(func) === undefined;
}

/** The header defining a unit's inline hosts: `D2Common/DATATBLS/MonsterTbls.h` -> `.inline.h`. */
export function inlineHostHeaderPath(unitHeaderPath: string): string {
  return unitHeaderPath.replace(/\.h$/, '') + '.inline.h';
}

/** Whether a tree path is a unit's inline header. */
export function isInlineHeaderPath(path: string): boolean {
  return path.endsWith('.inline.h');
}

/**
 * The key an inline host contributes to its unit's recorded statics: the unit's
 * .cpp and its inline header were written under the set of functions the header
 * defines, so a function that gains or loses the tag re-emits the unit.
 */
export function inlineHostKey(address: string): string {
  return `I:${String(address).replace(/^.*:/, '').replace(/^0x/i, '').toLowerCase().padStart(8, '0')}`;
}

/** Tagged functions that are not emitted as header inlines, with the reason, for the run's report. */
export function refusedInlineHosts(functions: ReadonlyArray<ExtractedFunction>): string[] {
  const out: string[] = [];
  for (const f of functions) {
    if (!hasInlineHostTag(f)) continue;
    const why = inlineHostRefusal(f);
    if (why) out.push(`${f.address} ${f.namespace ? `${f.namespace}::` : ''}${f.name} (${why})`);
  }
  return out;
}

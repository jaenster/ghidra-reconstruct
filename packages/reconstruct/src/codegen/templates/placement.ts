/**
 * Where a registered class's member definitions go.
 *
 * Each module compiled its own copy of every template member it used, and the
 * linker kept one per COMDAT: the CELLIST members sit in D2CMP's address run,
 * the SGAMEDATA ones twice, once in D2Client's run and once in D2Game's. So a
 * member is defined beside the module code it was linked with: in the directory
 * of the nearest function BELOW it that belongs to a module, in a unit named
 * for the element the instantiation is over (`D2CMP/SRC/stpl_CELLIST.cpp`).
 * Class members (an element's own dtor, IgnoreList's methods) are not module
 * code and are passed over; their namespace names no module.
 */

import type { ExtractedFunction } from '../../types.js';
import { normalizeUnitName } from '../namespace.js';
import type { TemplateRegistry } from './registry.js';

function addressValue(address: string): number {
  const hex = address.includes(':') ? address.slice(address.lastIndexOf(':') + 1) : address;
  return parseInt(hex, 16);
}

/**
 * The unit of every registered member, keyed by address. `moduleNames` are the
 * project's modules; a function homed under one of them is module code.
 */
export function placeTemplateMembers(
  registry: TemplateRegistry,
  functions: readonly ExtractedFunction[],
  moduleNames: ReadonlySet<string>,
): Map<string, string> {
  const ordered = [...functions].sort((a, b) => addressValue(a.address) - addressValue(b.address));
  const fallbackDir = registry.header.split('/').slice(0, -1).join('::');
  const placement = new Map<string, string>();
  let moduleDir: string | undefined;
  for (const f of ordered) {
    const ns = f.namespace ?? undefined;
    if (ns && registry.isClassScope(ns)) {
      const element = registry.instantiation(ns)?.element ?? ns;
      const dir = moduleDir ?? fallbackDir;
      placement.set(f.address, `${dir ? `${dir}::` : ''}${registry.implPrefix}${element}`);
      continue;
    }
    if (!ns) continue;
    // A unit's file is its last segment, inside the directory the rest spell; a
    // one-segment unit is `X/X.cpp`.
    const segments = normalizeUnitName(ns).split('::');
    if (!moduleNames.has(segments[0])) continue;
    moduleDir = segments.length > 1 ? segments.slice(0, -1).join('::') : segments[0];
  }
  return placement;
}

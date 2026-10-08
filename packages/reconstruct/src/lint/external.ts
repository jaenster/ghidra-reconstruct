/**
 * Who calls into the rebuilt image from outside it.
 *
 * Two of the convention checks find a class that is everywhere in the tree (a callback type or
 * a method whose register convention the rebuild dropped) and harmful only when code that was
 * NOT rebuilt makes the call. The list of such callers is data: external-callers.json.
 */

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** tsc does not copy the data file into dist, so a built cli reads it from src beside dist. */
function defaultPath(): string {
  const here = fileURLToPath(new URL('./external-callers.json', import.meta.url));
  return existsSync(here) ? here : fileURLToPath(new URL('../../src/lint/external-callers.json', import.meta.url));
}

export interface ExternalCallers {
  /** 1.14d address -> the module that calls it from outside. */
  functions: Map<number, { module: string; name: string }>;
  /** Callback typedef names and `Struct.member` names called from outside. */
  callbacks: Map<string, string>;
}

let cached: ExternalCallers | null = null;

export function loadExternalCallers(path?: string): ExternalCallers {
  if (cached && !path) return cached;
  const raw = JSON.parse(readFileSync(path ?? defaultPath(), 'utf8'));
  const out: ExternalCallers = { functions: new Map(), callbacks: new Map() };
  for (const [module, m] of Object.entries<any>(raw.modules ?? {})) {
    for (const f of m.functions ?? []) out.functions.set(parseInt(f.va, 16), { module, name: f.name });
    for (const c of [...(m.callbackTypes ?? []), ...(m.callbackMembers ?? [])]) out.callbacks.set(c, module);
  }
  if (!path) cached = out;
  return out;
}

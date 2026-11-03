/**
 * A fingerprint of the generator's compiled code.
 *
 * The incremental path reuses text that a PREVIOUS run emitted. That is only
 * sound while the code that emitted it is the code that would emit it again. Let
 * the generator be rebuilt between two rebuilds and the tree becomes a mix of two
 * generator versions: the re-emitted units carry the new behaviour, every reused
 * unit still carries the old, and nothing in the output says so.
 *
 * This is not hypothetical. The batch pipeline already carries the same warning -
 * "never run a regen while an agent is editing the generator, this has cost a full
 * run twice" - and it cost a third during this daemon's development: a plugin was
 * recompiled 3 minutes into a 9-minute reference run, and the resulting tree was
 * mistaken for evidence that the generator was nondeterministic. It was not. The
 * inputs had changed.
 *
 * A daemon that runs for days across an actively edited generator will meet this
 * constantly, so it is checked rather than hoped for. The response is not a resync
 * - the MODEL is still perfectly good, it came from Ghidra - but a full re-emit,
 * because every cached unit was produced by code that no longer exists.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * The packages that decide the emitted bytes. Deliberately a list rather than
 * "everything under packages/": a new package that does affect generation must be
 * added here consciously, which is a smaller risk than silently re-emitting the
 * world whenever any unrelated package is touched.
 */
const GENERATION_PACKAGES = ['shared', 'cpp-parser', 'reconstruct'];

/**
 * Hash the emitted JavaScript of every workspace package.
 *
 * Size and mtime rather than content: the point is to notice a rebuild, and a
 * rebuild always moves both. Hashing ~1500 files' contents on every rebuild would
 * cost more than it protects.
 */
export async function buildFingerprint(repoRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const packagesDir = join(repoRoot, 'packages');

  // Only the packages whose code decides what gets emitted. `live` is the
  // orchestrator: rebuilding it cannot change a single byte of the output, and
  // treating it as generation code makes every daemon restart after a change to
  // the daemon itself cost a full ~9-minute re-emit for nothing.
  const packages = GENERATION_PACKAGES.filter(p => existsSync(join(packagesDir, p)));
  if (packages.length === 0) return 'unavailable';

  for (const pkg of packages) {
    const dist = join(packagesDir, pkg, 'dist');
    for (const file of await walk(dist)) {
      try {
        const s = await stat(file);
        hash.update(file.slice(repoRoot.length));
        hash.update(String(s.size));
        hash.update(String(Math.floor(s.mtimeMs)));
      } catch {
        // Vanished mid-walk: a build is running right now, which is itself the
        // condition this guard exists to catch. Fold the absence in.
        hash.update(`${file}:missing`);
      }
    }
  }
  return hash.digest('hex').slice(0, 16);
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full)));
    else if (e.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/**
 * Environment switches that change what the generator emits (each read where it
 * decides: impl.ts artifact lowering, the goto validator and copy policy, the
 * branch-layout search). The daemon's environment carries them into every
 * generation, so they belong to the generator the tree was emitted by.
 */
export const OUTPUT_ENV_SWITCHES = [
  'RECON_ARTIFACT_LOWERING',
  'GHIDRA_GOTO_VALIDATOR',
  'GHIDRA_GOTO_COPY_POLICY',
  'GHIDRA_BRANCH_LAYOUT_W1',
  'GHIDRA_BRANCH_LAYOUT_SEARCH',
] as const;

/**
 * The override bodies the generator ships (`overrides/`, with its registry). They
 * are not compiled, so the dist fingerprint does not see them, yet the generator
 * emits them verbatim: a checkout that changes only an override body is a new
 * generator. Hashed by content.
 */
export async function builtinOverridesFingerprint(repoRoot: string): Promise<string> {
  const hash = createHash('sha256');
  const dir = join(repoRoot, 'overrides');
  for (const file of await walkAll(dir)) {
    hash.update(`${file.slice(dir.length)}\u0000`);
    hash.update(await readFile(file));
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * The generator's configuration outside its own repository: the project's
 * project.json (modules, type ownership, overrides and their patches, templates,
 * foreign references...), the content of every override source it names, and the
 * output switches in `env`. Any change can move any unit - a function into another
 * module, a type into another header - so it is treated as a new generator: every
 * unit is emitted again. The foreign sources' CONTENT is not part of this; it is
 * watched on its own and needs only a re-selection (foreign-watch.ts).
 */
export async function configFingerprint(projectDir: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const hash = createHash('sha256');
  let raw = '';
  try {
    raw = await readFile(join(projectDir, 'project.json'), 'utf-8');
  } catch {
    raw = '\u0000missing';
  }
  hash.update(`project.json\u0000${raw}\u0000`);
  let overrides: Array<{ sourceFile?: string }> = [];
  try {
    overrides = (JSON.parse(raw) as { overrides?: Array<{ sourceFile?: string }> }).overrides ?? [];
  } catch {
    // An unparsable project.json fails the generation; its text is already hashed.
  }
  for (const o of overrides) {
    if (!o.sourceFile) continue;
    const path = resolve(projectDir, o.sourceFile);
    let text: string;
    try {
      text = await readFile(path, 'utf-8');
    } catch {
      text = '\u0000missing';
    }
    hash.update(`${o.sourceFile}\u0000${text}\u0000`);
  }
  for (const name of OUTPUT_ENV_SWITCHES) hash.update(`${name}=${env[name] ?? ''}\u0000`);
  return hash.digest('hex').slice(0, 16);
}

/**
 * Everything the cached output was emitted under besides the model and the foreign
 * sources: the compiled generator, its override bodies, and its configuration.
 */
export async function generatorFingerprint(
  repoRoot: string,
  projectDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const parts = [
    await buildFingerprint(repoRoot),
    await builtinOverridesFingerprint(repoRoot),
    await configFingerprint(projectDir, env),
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

async function walkAll(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkAll(full)));
    else out.push(full);
  }
  return out;
}

export interface BuildCheck {
  fingerprint: string;
  /** True when reused output from the previous run can still be trusted. */
  reusable: boolean;
  reason: string;
}

export function checkBuild(previous: string | null | undefined, current: string): BuildCheck {
  if (!previous) {
    return {
      fingerprint: current,
      reusable: false,
      reason: 'no generator fingerprint recorded; re-emitting everything once to establish one',
    };
  }
  if (previous !== current) {
    return {
      fingerprint: current,
      reusable: false,
      reason:
        `the generator, its overrides or its configuration changed (${previous} -> ${current}); ` +
        `every cached unit was emitted under inputs that no longer hold, so all of them are re-emitted`,
    };
  }
  return { fingerprint: current, reusable: true, reason: 'generator unchanged since the last rebuild' };
}

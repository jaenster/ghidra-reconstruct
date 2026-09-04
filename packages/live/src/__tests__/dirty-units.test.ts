/**
 * Dirty-unit selection, against the real model.
 *
 * These run on the actual D2 snapshot rather than fixtures, because the failures
 * worth catching are the ones that only appear at real scale: 186 function names
 * carried by more than one function, types referenced from 200+ units, and a
 * dependency graph whose edges are names while identity is addresses. A synthetic
 * three-symbol fixture agrees with every wrong implementation.
 *
 * Skipped when the snapshot is absent, so a checkout without one still passes.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  selectDirtyUnits,
  computeHashCache,
  loadBuildInfo,
  expandChangedTypes,
  type SymbolHashCache,
} from '../dirty-units.js';
import type { ExtractedFunction, ExtractedDataType, AnalyzedDataSymbol } from '@ghidra-mcp/reconstruct';

const PROJECT = join(import.meta.dirname, '..', '..', '..', '..', 'project');
const SNAPSHOT = join(PROJECT, '.ghidra-mcp', 'codegen-snapshot');
const BUILDINFO = join(PROJECT, '.ghidra-mcp', 'buildinfo.json');

const AVAILABLE = existsSync(join(SNAPSHOT, 'functions.ndjson')) && existsSync(BUILDINFO);
const SKIP = AVAILABLE ? undefined : 'no snapshot/buildinfo in project/.ghidra-mcp';

function ndjson<T>(name: string): T[] {
  const out: T[] = [];
  for (const line of readFileSync(join(SNAPSHOT, name), 'utf-8').split('\n')) {
    if (line.trim()) out.push(JSON.parse(line) as T);
  }
  return out;
}

describe('selectDirtyUnits', { skip: SKIP, timeout: 300_000 }, () => {
  let functions: ExtractedFunction[];
  let dataTypes: ExtractedDataType[];
  let globals: AnalyzedDataSymbol[];
  let buildInfo: Awaited<ReturnType<typeof loadBuildInfo>>;
  let baseline: SymbolHashCache;

  before(async () => {
    functions = ndjson<ExtractedFunction>('functions.ndjson');
    dataTypes = ndjson<ExtractedDataType>('dataTypes.ndjson');
    globals = ndjson<AnalyzedDataSymbol>('globals.ndjson');
    buildInfo = await loadBuildInfo(BUILDINFO);
    baseline = computeHashCache({ functions, dataTypes, globals });
  });

  const select = (fns = functions, dts = dataTypes, gls = globals, prev = baseline) =>
    selectDirtyUnits({ buildInfo, previous: prev, functions: fns, dataTypes: dts, globals: gls });

  it('reports nothing dirty when nothing moved', () => {
    const r = select();
    assert.deepStrictEqual(r.units, [], `expected no dirty units, got ${r.units?.length}: ${r.reason}`);
  });

  it('a cold start re-emits everything rather than guessing', () => {
    const r = select(functions, dataTypes, globals, null as unknown as SymbolHashCache);
    assert.strictEqual(r.units, null, 'no previous cache must mean a full re-emit');
  });

  it('marks the owning unit dirty when a function body changes', () => {
    const target = functions.find(f => f.namespace && f.decompiled)!;
    assert.ok(target, 'need a namespaced function with a body');
    const modified = functions.map(f =>
      f.address === target.address ? { ...f, decompiled: `${f.decompiled}\n// touched` } : f,
    );
    const r = select(modified);
    assert.ok(r.units && r.units.length > 0, `expected dirty units, got ${r.reason}`);
    const owner = buildInfo!.modules.find(m => (m.functionNames ?? []).includes(target.name));
    if (owner) {
      assert.ok(
        r.units!.includes(owner.unitName),
        `the unit owning ${target.name} (${owner.unitName}) must be dirty; got ${r.units!.slice(0, 5)}`,
      );
    }
  });

  it('RENAME: marks the unit that owned the OLD name', () => {
    // The case that was broken. buildinfo files the unit under the old spelling,
    // so a selection that only knows the new name leaves the one unit that must
    // be re-emitted looking clean.
    const owner = buildInfo!.modules.find(
      m => (m.functionNames ?? []).length > 0 &&
           functions.some(f => f.name === (m.functionNames ?? [])[0]),
    )!;
    const oldName = owner.functionNames![0]!;
    const target = functions.find(f => f.name === oldName)!;

    const renamed = functions.map(f =>
      f.address === target.address ? { ...f, name: `${f.name}_renamed_probe` } : f,
    );
    const r = select(renamed);
    assert.ok(r.units, `a rename must not fail open here; got ${r.reason}`);
    assert.ok(
      r.units!.includes(owner.unitName),
      `renaming ${oldName} must dirty ${owner.unitName}; got ${r.units!.slice(0, 8)} (${r.reason})`,
    );
    assert.ok(
      r.changedSymbols.includes(oldName),
      'the old name must be reported as changed, since that is how the graph files it',
    );
  });

  it('DELETE: marks the unit that owned the removed function', () => {
    const owner = buildInfo!.modules.find(
      m => (m.functionNames ?? []).length > 0 &&
           functions.some(f => f.name === (m.functionNames ?? [])[0]),
    )!;
    const gone = owner.functionNames![0]!;
    const target = functions.find(f => f.name === gone)!;
    const without = functions.filter(f => f.address !== target.address);

    const r = select(without);
    assert.ok(r.units, `a delete must not fail open; got ${r.reason}`);
    assert.ok(
      r.units!.includes(owner.unitName),
      `deleting ${gone} must dirty ${owner.unitName}; got ${r.reason}`,
    );
  });

  it('RETYPE: reaches every unit that depends on the type, not just its owner', () => {
    // The case a body-diff trigger misses: no function body changed at all here.
    const byDeps = new Map<string, number>();
    for (const m of buildInfo!.modules) {
      for (const d of m.deps ?? []) {
        if (d.strength === 'by-pointer' || d.strength === 'by-value' || d.strength === 'type-ref') {
          byDeps.set(d.symbol, (byDeps.get(d.symbol) ?? 0) + 1);
        }
      }
    }
    const [typeName, expectedUnits] = [...byDeps.entries()]
      .filter(([n]) => dataTypes.some(dt => dt.name === n))
      .sort((a, b) => b[1] - a[1])[0]!;
    assert.ok(expectedUnits > 10, `need a widely-used type, ${typeName} has ${expectedUnits}`);

    const retyped = dataTypes.map(dt =>
      dt.name === typeName
        ? { ...dt, fields: [...((dt as { fields?: unknown[] }).fields ?? []), { name: '__probe', dataType: 'int', offset: 0 }] }
        : dt,
    ) as ExtractedDataType[];

    const r = select(functions, retyped);
    assert.ok(r.units, `a retype must not fail open; got ${r.reason}`);
    assert.ok(
      r.units!.length > 10,
      `retyping ${typeName} (${expectedUnits} dependent modules) must dirty many units, got ${r.units!.length}`,
    );
  });

  it('containment: a struct embedding a changed struct is itself changed', () => {
    const embedded = dataTypes.find(dt => {
      const fields = (dt as unknown as { fields?: Array<{ dataType?: string }> }).fields ?? [];
      return fields.some(f => {
        const bare = (f.dataType ?? '').replace(/[*\[\]0-9]/g, '').trim();
        return bare && dataTypes.some(o => o.name === bare && o.name !== dt.name);
      });
    });
    if (!embedded) return; // nothing to prove on this model
    const fields = (embedded as unknown as { fields: Array<{ dataType?: string }> }).fields;
    const inner = fields
      .map(f => (f.dataType ?? '').replace(/[*\[\]0-9]/g, '').trim())
      .find(n => n && dataTypes.some(o => o.name === n && o.name !== embedded.name))!;

    const expanded = expandChangedTypes([inner], dataTypes);
    assert.ok(
      expanded.has(embedded.name),
      `${embedded.name} embeds ${inner}, so a change to ${inner} must reach it`,
    );
  });
});

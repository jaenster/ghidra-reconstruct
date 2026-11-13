import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { AnalyzedDataSymbol, SourceFile } from '../types.js';
import { classifyGlobalVisibility, ownerModuleOfUsers, type GlobalVisibilityInput } from './global-visibility.js';

function g(name: string, address: string, size: number, extra: Partial<AnalyzedDataSymbol> = {}): AnalyzedDataSymbol {
  return { name, address, size, dataType: 'int', isInitialized: false, xrefCount: 0, scope: 'global', ...extra } as AnalyzedDataSymbol;
}

function file(path: string, content: string): [string, SourceFile] {
  return [path, { path, content, type: path.endsWith('.h') ? 'header' : 'implementation', functions: [], includes: [] }];
}

function run(candidates: AnalyzedDataSymbol[], files: Array<[string, SourceFile]>, over: Partial<GlobalVisibilityInput> = {}) {
  const inits = new Map<AnalyzedDataSymbol, Set<string>>();
  for (const c of [...candidates, ...(over.others ?? [])]) {
    const names = (c as { __names?: string[] }).__names;
    if (names) inits.set(c, new Set(names));
  }
  return classifyGlobalVisibility({
    candidates,
    others: [],
    files: new Map(files),
    foreign: new Set(),
    emittedFunctions: new Set(),
    initializerNames: x => inits.get(x) ?? new Set(),
    moduleOfFile: p => p.split('/')[0],
    ...over,
  });
}

const withInit = (x: AnalyzedDataSymbol, names: string[]): AnalyzedDataSymbol =>
  Object.assign(x, { isInitialized: true, initializedData: { kind: 'array', elements: [] }, __names: names });

describe('global visibility', () => {
  it('a global a body names is referenced, by the modules of the files that name it', () => {
    const a = g('gnUsed', '00700000', 4);
    const r = run([a], [file('D2Client/A.cpp', 'void f() { gnUsed = 1; }'), file('D2Common/B.cpp', 'int h() { return gnUsed; }')]);
    const e = r.entries.get(a)!;
    assert.strictEqual(e.verdict, 'referenced');
    assert.deepStrictEqual([...e.userModules].sort(), ['D2Client', 'D2Common']);
  });

  it('a name in a comment or a string is no reference; a macro body is', () => {
    const a = g('gnQuiet', '00700000', 4);
    const b = g('gnMacro', '00700010', 4);
    const r = run([a, b], [file('D2Client/A.cpp', '// gnQuiet\nvoid f() { log("gnQuiet"); }'), file('d2_platform.h', '#define READ_IT() (gnMacro)')]);
    assert.strictEqual(r.entries.get(a)!.verdict, 'dead');
    assert.strictEqual(r.entries.get(b)!.verdict, 'referenced');
  });

  it('a hand-written source or an xref from an emitted function keeps a global', () => {
    const a = g('gnSupport', '00700000', 4);
    const b = g('gnByAddress', '00700010', 4, { referencingFunctions: ['D2Client::UI::Draw'] });
    const c = g('gnExcludedOnly', '00700020', 4, { referencingFunctions: ['compiler::_ValidateEH3RN'] });
    const r = run([a, b, c], [], { foreign: new Set([a]), emittedFunctions: new Set(['D2Client::UI::Draw']) });
    assert.strictEqual(r.entries.get(a)!.verdict, 'referenced');
    assert.strictEqual(r.entries.get(b)!.verdict, 'referenced');
    assert.strictEqual(r.entries.get(b)!.byAddressOnly, true);
    assert.strictEqual(r.entries.get(c)!.verdict, 'dead');
  });

  it('a global only a live initializer names is initializer-only, with its referrers', () => {
    const table = withInit(g('gaTable', '00700000', 8), ['gszEntry']);
    const entry = g('gszEntry', '00700100', 4);
    const r = run([table, entry], [file('D2Client/A.cpp', 'void f() { gaTable[0] = 0; }')]);
    assert.strictEqual(r.entries.get(entry)!.verdict, 'initializer-only');
    assert.deepStrictEqual([...r.entries.get(entry)!.referrers], [table]);
  });

  // gpszD2LngFileName 006d5ee8: no xref in Ghidra, no name in the tree, its bytes match.
  it('an unnamed object with bytes of the original is kept, and what its initializer names with it', () => {
    const table = withInit(g('gaUnnamedTable', '00700000', 8), ['gszEntry']);
    const entry = g('gszEntry', '00700100', 4);
    const r = run([table, entry], []);
    assert.strictEqual(r.entries.get(table)!.verdict, 'unreferenced');
    assert.strictEqual(r.entries.get(entry)!.verdict, 'initializer-only');
  });

  it('unnamed storage without bytes is dead', () => {
    const bss = g('gnUnnamedBss', '00700000', 4);
    assert.strictEqual(run([bss], []).entries.get(bss)!.verdict, 'dead');
  });

  // gFaultHandlerList 0072fa14 (12 bytes) and its slot labels carrying the list's size.
  it("a slot label's own size does not swallow the next object", () => {
    const list = g('gFaultHandlerList', '0072fa14', 12);
    const slot = g('gFaultHandlerList.head.pNext', '0072fa1c', 12);
    const next = g('gaszLanguageNames', '0072fa20', 128, { isInitialized: true });
    const r = run([list, slot, next], [file('Storm/A.cpp', 'void f() { gFaultHandlerList.head.pNext = 0; }')]);
    assert.strictEqual(r.entries.get(slot)!.verdict, 'interior');
    assert.strictEqual(r.entries.get(next)!.verdict, 'unreferenced');
  });

  it('a global outside the candidates (homed, file-local) is live and its initializer counts', () => {
    const homed = withInit(g('gaHomed', '00700000', 8, { homeFile: 'D2Client/A.cpp' }), ['gszEntry']);
    const entry = g('gszEntry', '00700100', 4);
    const r = run([entry], [], { others: [homed] });
    assert.strictEqual(r.entries.get(entry)!.verdict, 'initializer-only');
  });

  // ClientSideUnitHashTables_1__0_: a label Ghidra split off a slot of a live table.
  it('an unreferenced label inside a live object is interior', () => {
    const parent = g('gaClientSideUnitHashTables', '00700000', 0x200);
    const slot = g('ClientSideUnitHashTables_1__0_', '00700080', 4);
    const r = run([parent, slot], [file('D2Client/A.cpp', 'void f() { gaClientSideUnitHashTables[0] = 0; }')]);
    assert.strictEqual(r.entries.get(slot)!.verdict, 'interior');
    assert.strictEqual(r.entries.get(slot)!.neighbour, parent);
  });

  // gaRoadPresetDirectionLookup: the code names the centre of a 9-entry table.
  it('an unreferenced table holding a live label is its container', () => {
    const base = g('gaRoadPresetTable', '006f0fc0', 36);
    const centre = g('gaRoadPresetDirectionLookup', '006f0fd0', 4);
    const r = run([base, centre], [file('D2Common/A.cpp', 'int f(int i) { return gaRoadPresetDirectionLookup[i]; }')]);
    assert.strictEqual(r.entries.get(base)!.verdict, 'container');
    assert.strictEqual(r.entries.get(base)!.neighbour, centre);
  });

  it('an unreferenced neighbour that only touches a live extent is dead', () => {
    const live = g('gaLive', '00700000', 16);
    const next = g('gnAfter', '00700010', 4);
    const r = run([live, next], [file('D2Common/A.cpp', 'int f() { return gaLive[3]; }')]);
    assert.strictEqual(r.entries.get(next)!.verdict, 'dead');
  });
});

describe('owner module of a root-scope global', () => {
  const imports: Record<string, string[]> = { D2Client: ['D2Common', 'Fog'], D2Common: ['Fog'], D2Game: ['D2Common', 'Fog'], Fog: [] };
  const mayUse = (u: string, o: string) => imports[u]?.includes(o) ?? false;

  it('one user owns it', () => {
    assert.strictEqual(ownerModuleOfUsers(new Set(['D2Game']), mayUse), 'D2Game');
  });
  it('several users: the one they all import', () => {
    assert.strictEqual(ownerModuleOfUsers(new Set(['D2Client', 'D2Common', 'D2Game']), mayUse), 'D2Common');
  });
  it('users that cannot share one: no owner', () => {
    assert.strictEqual(ownerModuleOfUsers(new Set(['D2Client', 'D2Game']), mayUse), undefined);
  });
  it('no user: no owner', () => {
    assert.strictEqual(ownerModuleOfUsers(new Set(), mayUse), undefined);
  });
});

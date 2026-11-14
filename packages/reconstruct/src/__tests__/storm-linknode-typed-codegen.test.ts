import { it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generateFunctionImplementation, getParseErrorCount, type ImplGenContext } from '../codegen/impl.js';
import { setAggregateTypeNames } from '../codegen/platform-types.js';
import { TemplateRegistry, setTemplateRegistry } from '../codegen/templates/registry.js';
import { memberModel } from '../codegen/templates/members.js';
import { vc8formBodyHash } from '../codegen/vc8form-spec.js';
import type { ExtractedDataType, ExtractedFunction, ReconstructOptions } from '../types.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/storm-linknode-typed.json', import.meta.url), 'utf8'));
const types = fixture.dataTypes as ExtractedDataType[];
const functions = fixture.functions.map((r: { fn: ExtractedFunction }) => r.fn) as ExtractedFunction[];
afterEach(() => setTemplateRegistry(undefined));
function context(): ImplGenContext {
  const registry = TemplateRegistry.build(fixture.templateConfig, [...types.map(t => t.name), ...functions.map(f => f.namespace!)]);
  registry.setMembers(memberModel(registry, functions, []));
  registry.setComdats(new Set(fixture.comdatAddresses));
  setTemplateRegistry(registry);
  setAggregateTypeNames(types);
  const aggregates = fixture.dataTypes.filter((t: { kind: string }) => t.kind === 'STRUCTURE') as Array<{
    name: string; size: number; fields: Array<{ name: string; dataType: string; offset: number; size: number }>;
  }>;
  return { targetPointerSize: 4, targetLanguageId: 'x86:LE:32:default', funcPtrArgCasts: {
    paramFuncdefs: {}, funcdefSignatures: {}, functionSignatures: {}, variableNames: [],
    voidPointerFunctions: [], rootQualifiedTypedefs: [],
    structFields: Object.fromEntries(aggregates.map(t => [t.name, Object.fromEntries(t.fields.map(f => [f.name, f.dataType]))])),
    structFieldOffsets: Object.fromEntries(aggregates.map(t => [t.name, Object.fromEntries(t.fields.map(f => [f.name, f.offset]))])),
    structLayouts: Object.fromEntries(aggregates.map(t => [t.name, t.fields.map(f => ({ name: f.name, type: f.dataType, offset: f.offset, size: f.size }))])),
    aggregateMembers: Object.fromEntries(aggregates.map(t => [t.name, t.fields.map(f => f.name)])),
    aggregateSizes: Object.fromEntries(aggregates.map(t => [t.name, t.size])),
    typedefTargets: fixture.typedefTargets,
  } };
}
const options = fixture.options as ReconstructOptions;
it('full emission recognizes the three native-identical LinkNode variants', () => {
  const facts = context(), count = getParseErrorCount();
  for (const r of fixture.functions) {
    assert.equal(vc8formBodyHash(r.fn.decompiled), r.dh);
    const code = generateFunctionImplementation(r.fn, undefined, options, facts);
    assert.match(code, r.fn.address === '0045bbe0' ? /switch \(nMode\)/ : /switch \(nLinkType\)/, 'the normal native branch facts recover the existing switch');
    assert.equal(code.match(/D2_StormNextLink/g)?.length, 2, 'unlink and insert both use the existing helper');
    assert.doesNotMatch(code, /if \(nLinkBase < 0\)|if \(pListHead < 0\)|szName \+ pListHead/);
    if (r.fn.address === '0045bbe0') {
      assert.match(code, /D2_StormNextLink\(ppCurNode, -1\)/);
      assert.match(code, /D2_StormNextLink\(ppTarget, \(intptr_t\)\*ppList\)/);
      assert.doesNotMatch(code, /pPrevLink = ppCurNode\[1\]/);
      assert.match(code, /int\*\* pPrevLink;/, 'normal slot typing no longer has to also carry the raw next word');
      assert.match(code, /\*pPrevLink = pNext;/);
    } else assert.match(code, r.fn.address === '00601fc0'
        ? /D2_StormNextLink\(&pExisting->m_link, this->m_linkoffset\)/
        : /D2_StormNextLink\(pExisting, this->m_linkoffset\)/);
  }
  assert.equal(getParseErrorCount(), count);
});
it('word-array recovery needs no invented structure fields', () => {
  const facts = context();
  const code = generateFunctionImplementation(functions[2], undefined, options, {
    ...facts, funcPtrArgCasts: { ...facts.funcPtrArgCasts!, structFields: {}, structFieldOffsets: {}, structLayouts: {}, aggregateSizes: {} },
  });
  assert.equal(code.match(/D2_StormNextLink/g)?.length, 2);
});
it('the owning emitter refuses an unknown byte-array extent or a shifted embedded link', () => {
  const facts = context(), tables = facts.funcPtrArgCasts!;
  const pointer = generateFunctionImplementation(functions[1], undefined, options, {
    ...facts, funcPtrArgCasts: { ...tables, aggregateSizes: {} },
  });
  assert.match(pointer, /szName \+ pListHead - 0x10/);
  assert.equal(pointer.match(/D2_StormNextLink/g)?.length, 1);
  const embedded = generateFunctionImplementation(functions[0], undefined, options, {
    ...facts, funcPtrArgCasts: { ...tables, structFieldOffsets: { ...tables.structFieldOffsets, TCELENTRY: { m_link: 4 } } },
  });
  assert.match(embedded, /if \(nLinkBase < 0\)/);
  assert.doesNotMatch(embedded, /D2_StormNextLink\(&pExisting->m_link/);
});

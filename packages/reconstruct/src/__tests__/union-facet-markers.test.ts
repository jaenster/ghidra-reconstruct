/**
 * A forced union facet (Ghidra `UnionFacetSymbol`, the SUnitEvent fpItemEventFunc fix at
 * v1268) is stored as a HASH local named `unionfacet...`. It is a decompiler marker, never
 * a variable: no declaration, rename, frame slot or type dependency may come from it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { dropUnionFacetMarkers, isUnionFacetMarker } from '../codegen/index.js';

describe('union-facet markers', () => {
  it('recognises the marker names and nothing else', () => {
    for (const n of ['unionfacet', 'unionfacet1_5f541c2770', 'unionfacet12_0']) assert.ok(isUnionFacetMarker(n), n);
    for (const n of ['pUnionFacet', 'unionfacets', 'nUnionfacet1', 'pMemoryToFree']) assert.ok(!isUnionFacetMarker(n), n);
  });

  it('drops them from the local list and keeps the real locals', () => {
    const fns = [{ localVariables: [
      { name: 'pMemoryToFree', dataType: 'D2SUnitEventStrc *' },
      { name: 'unionfacet3_3f00ddbc24', dataType: 'D2SUnitEventArgUnion' },
    ] }];
    assert.strictEqual(dropUnionFacetMarkers(fns), 1);
    assert.deepStrictEqual(fns[0].localVariables.map(v => v.name), ['pMemoryToFree']);
  });
});

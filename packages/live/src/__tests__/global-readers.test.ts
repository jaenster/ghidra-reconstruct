import { describe, it } from 'node:test';
import assert from 'node:assert';

import { applyEvents, buildIndices, dataRefIndex, type ChangeEvent, type LiveModel } from '../model.js';

/**
 * v1852 changed three data items and the daemon re-read them, but two readers kept the
 * text Ghidra printed before:
 *  - gdwRendererMode / gpD3DGroundTileVertexBuffer were retyped to arrays. Ghidra lists the
 *    reader as D2Direct3D::Renderer::Direct3D::DrawGroundTile, the model resolved it by bare
 *    name, and four functions are called DrawGroundTile: another one was decompiled again.
 *  - the string at 006ccaf4 changed. A string keeps no global record, so there was no
 *    referencing-functions list to go by, and GetAndCreateSavePath kept its old literal.
 * A data change has to reach every function whose code references the data, by address.
 */

interface FakeData { name: string; dataType: string; size: number; referencingFunctions: string[] }

function fake(fns: Array<{ address: string; name: string; namespace: string }>, data: Map<string, FakeData>) {
  const decompiled: string[] = [];
  const client = {
    async sendCommand(cmd: string, params: Record<string, unknown> = {}) {
      const fn = fns.find(f => f.address === params.address);
      switch (cmd) {
        case 'get_function_info':
          if (!fn) throw new Error('no function');
          return { name: fn.name, address: fn.address, namespace: fn.namespace, signature: `void ${fn.name}(void)`, returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 16 };
        case 'list_functions': {
          const name = String(params.regex).replace(/^\^|\$$/g, '');
          return { functions: fns.filter(f => f.name === name).map(f => ({ name: f.name, address: f.address, namespace: f.namespace, signature: `void ${f.name}(void)`, returnType: 'void', parameters: [], localVariables: [], callingConvention: '__stdcall', size: 16 })) };
        }
        case 'decompile':
          decompiled.push(String(params.address));
          return { pseudocode: `void ${fn?.name}(void)\n{\n}\n` };
        case 'execute_script': {
          const code = String(params.code);
          if (code.includes('st.getSymbols(ad)')) {
            const asked = [...code.matchAll(/"([0-9a-f]+)"/g)].map(m => m[1]);
            return { success: true, output: asked.filter(a => data.has(a)).map(a => `L\t${a}\t${data.get(a)!.name}\n`).join('') };
          }
          return { success: true, output: '' };
        }
        case 'list_data_symbols': {
          const names = new Set(String(params.regex).replace(/^\^\(\?:|\)\$$/g, '').split('|'));
          const rows = [...data].filter(([, d]) => names.has(d.name)).map(([address, d]) => ({
            name: d.name, address, dataType: d.dataType, size: d.size, isInitialized: false,
            xrefCount: d.referencingFunctions.length, referencingFunctions: d.referencingFunctions,
          }));
          return { globals: rows, total: rows.length };
        }
        default: return {};
      }
    },
  };
  return { client: client as never, decompiled };
}

const ref = (to: string) => ({ ins: '00400000', op: 0, to, type: 'DATA', encoded: true });

function model(globals: unknown[]): LiveModel {
  return {
    seq: 0, options: {},
    primary: {
      functions: [
        { name: 'GetAndCreateSavePath', namespace: 'Fog::Source::SFile', address: '00407050', calledFunctions: [], decompiled: 'x', operandRefs: { refs: [ref('006ccaf4')] } },
        { name: 'DrawGroundTile', namespace: 'D2Direct3D::Renderer::Direct3D', address: '006b9170', calledFunctions: [], decompiled: 'x' },
        { name: 'InitGroundTileCache', namespace: 'D2Direct3D::Renderer::Direct3D', address: '006b9800', calledFunctions: [], decompiled: 'x', operandRefs: { refs: [ref('009716b4')] } },
        { name: 'Unrelated', namespace: 'D2Game', address: '00500000', calledFunctions: [], decompiled: 'x', operandRefs: { refs: [ref('00971740')] } },
        { name: 'DrawGroundTile', namespace: 'D2Glide::Renderer', address: '006c95d0', calledFunctions: [], decompiled: 'x' },
        ...Array.from({ length: 40 }, (_, i) => ({ name: `Filler${i}`, address: (0x600000 + i * 16).toString(16).padStart(8, '0'), calledFunctions: [], decompiled: '' })),
      ],
      globals, dataTypes: [],
    },
  } as unknown as LiveModel;
}

const fns = [
  { address: '00407050', name: 'GetAndCreateSavePath', namespace: 'Fog::Source::SFile' },
  { address: '006b9170', name: 'DrawGroundTile', namespace: 'D2Direct3D::Renderer::Direct3D' },
  { address: '006b9800', name: 'InitGroundTileCache', namespace: 'D2Direct3D::Renderer::Direct3D' },
  { address: '00500000', name: 'Unrelated', namespace: 'D2Game' },
  { address: '006c95d0', name: 'DrawGroundTile', namespace: 'D2Glide::Renderer' },
];
const event = (key: string): ChangeEvent => ({ seq: 1852000001, kind: 'data.changed', target: 'global', key });

describe('a data change re-decompiles its readers', () => {
  it('resolves a namespace-qualified reader to that function, not another of the same name', async () => {
    const data = new Map([['0074c3d0', { name: 'gdwRendererMode', dataType: 'ushort[4]', size: 8, referencingFunctions: ['D2Direct3D::Renderer::Direct3D::DrawGroundTile'] }]]);
    const m = model([{ name: 'gdwRendererMode', address: '0074c3d0', dataType: 'uint32_t', size: 4, referencingFunctions: ['D2Direct3D::Renderer::Direct3D::DrawGroundTile'] }]);
    const { client, decompiled } = fake(fns, data);
    await applyEvents(m, buildIndices(m), [event('0074c3d0')], client);
    assert.deepStrictEqual(decompiled.sort(), ['006b9170']);
  });

  it('reaches the readers of a string, which keeps no global record', async () => {
    const data = new Map([['006ccaf4', { name: 's_NewSavePath_006ccaf4', dataType: 'string', size: 12, referencingFunctions: [] }]]);
    const m = model([]);
    const { client, decompiled } = fake(fns, data);
    await applyEvents(m, buildIndices(m), [event('006ccaf4')], client);
    assert.deepStrictEqual(decompiled, ['00407050']);
  });

  it('reaches a reader of any byte the data covers, old extent or new', async () => {
    // Retyped from a 4-byte scalar to ushort[65]: a reader of 009716b4 reads the array now.
    const data = new Map([['009716b0', { name: 'gpD3DGroundTileVertexBuffer', dataType: 'ushort[65]', size: 130, referencingFunctions: [] }]]);
    const m = model([{ name: 'gpD3DGroundTileVertexBuffer', address: '009716b0', dataType: 'uint', size: 4, referencingFunctions: [] }]);
    const { client, decompiled } = fake(fns, data);
    await applyEvents(m, buildIndices(m), [event('009716b0')], client);
    assert.deepStrictEqual(decompiled, ['006b9800'], 'the interior reader, not the one past the end (00971740)');
  });

  it('a label removed from an address still reaches its readers', async () => {
    const m = model([{ name: 'gszOld', address: '006ccaf4', dataType: 'char[12]', size: 12, referencingFunctions: [] }]);
    const { client, decompiled } = fake(fns, new Map());
    await applyEvents(m, buildIndices(m), [event('006ccaf4')], client);
    assert.deepStrictEqual(decompiled, ['00407050']);
    assert.equal(m.primary.globals.length, 0);
  });
});

describe('dataRefIndex', () => {
  it('answers the functions referencing a half-open range', () => {
    const idx = dataRefIndex([
      { name: 'a', address: '00401000', operandRefs: { refs: [ref('00700000'), ref('00700010')] } },
      { name: 'b', address: '00402000', operandRefs: { refs: [ref('0070000f')] } },
      { name: 'c', address: '00403000', operandRefs: { refs: [ref('Game.exe.ram:00700020')] } },
    ] as never);
    assert.deepStrictEqual([...idx.readers('00700000', 16)].sort(), ['00401000', '00402000']);
    assert.deepStrictEqual([...idx.readers('00700010', 1)], ['00401000']);
    assert.deepStrictEqual([...idx.readers('00700020', 4)], ['00403000']);
    assert.deepStrictEqual([...idx.readers('00700030', 4)], []);
  });
});

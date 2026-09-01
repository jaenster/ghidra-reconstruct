/**
 * A heterogeneous dispatch table needs the cast its arity disagreement argues
 * against.
 *
 * `Storm/Source/SSComp.cpp` carries
 *
 *   static SCompCodecEntryStrc paSCompCompressCodecTable[5] = {
 *       { 0x40, &SCOMP_ADPCMMonoEncode }, ...
 *   };
 *
 * whose second member is declared `pfnSCompCodec *` — five parameters. The five
 * codecs stored into it take six, seven and five, and that is not a modelling
 * error: `SCompCompress` calls through the slot as `(*(code *)pSrc[1])(...)`,
 * casting away the declared type at every call site, which is exactly what the
 * original source had to do to build the table in the first place.
 *
 * `functionInitializerCast` already compares the slot's funcdef against the
 * function's own prototype and writes the cast wherever they differ — but it
 * REFUSED to when the parameter COUNT differed, on the reasoning that a cast
 * cannot reconcile an arity. That reasoning holds for a CALL and not for a
 * STORE: `(pfnSCompCodec)&Fn` is a well-formed conversion between two function
 * pointer types whatever their arities, it names the same symbol, and without it
 * the initializer does not compile at all —
 *
 *   error: invalid conversion from 'void (*)(short int*, uint32_t*, short int*,
 *          uint32_t, uint32_t*, uint32_t)' to 'void (*)(short int*, short int**,
 *          int32_t, int32_t, void*)'
 *
 * The disagreement is still real and still worth a worklist, so it is still
 * counted; what changes is that the emitter no longer leaves uncompilable text
 * behind while counting it.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';

import {
  emitDataValue,
  setGlobalInitializerTypes,
  setInitializerAddressTable,
  setInitializerSignatureTables,
  setKnownFuncDefTypedefs,
  setMultidimArrayGlobals,
  getInitializerFuncPtrArityMismatches,
  recordCentralInitializerAddressReferences,
} from '../codegen/globals-header.js';
import { buildFuncPtrArgCastTables, buildGlobalAddressExtentTables } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol,
  DataValue,
  ExtractedDataType,
  ExtractedFunction,
  ExtractedFunctionDefinition,
  ExtractedString,
  ExtractedStruct,
} from '../types.js';

/** The codec slot's declared contract: five parameters. */
const PFN_SCOMP_CODEC: ExtractedFunctionDefinition = {
  name: 'pfnSCompCodec',
  kind: 'FUNCTION_DEFINITION',
  returnType: 'void',
  parameters: [
    { name: 'pDst', dataType: 'short *', ordinal: 0 },
    { name: 'pnDstLen', dataType: 'short * *', ordinal: 1 },
    { name: 'pSrc', dataType: 'int32_t', ordinal: 2 },
    { name: 'nSrcLen', dataType: 'int32_t', ordinal: 3 },
    { name: 'pUserData', dataType: 'void *', ordinal: 4 },
  ],
} as ExtractedFunctionDefinition;

const SCOMP_CODEC_ENTRY: ExtractedStruct = {
  name: 'SCompCodecEntryStrc',
  kind: 'STRUCTURE',
  size: 8,
  fields: [
    { name: 'dwMethodMask', dataType: 'uint32_t', offset: 0, size: 4 },
    { name: 'pfnCodec', dataType: 'pfnSCompCodec *', offset: 4, size: 4 },
  ],
} as unknown as ExtractedStruct;

/** A struct whose callback slot is a plain word, not a function pointer. */
const WORD_SLOT_ENTRY: ExtractedStruct = {
  name: 'SCompWordSlotStrc',
  kind: 'STRUCTURE',
  size: 8,
  fields: [
    { name: 'dwMethodMask', dataType: 'uint32_t', offset: 0, size: 4 },
    { name: 'dwCodec', dataType: 'uint32_t', offset: 4, size: 4 },
  ],
} as unknown as ExtractedStruct;

function fn(
  name: string,
  namespace: string,
  paramTypes: string[],
): ExtractedFunction {
  return {
    name,
    namespace,
    address: '00400000',
    signature: '',
    returnType: 'void',
    parameters: paramTypes.map((dataType, ordinal) => ({ name: `p${ordinal}`, dataType, ordinal })),
    localVariables: [],
    callingConvention: '__fastcall',
    size: 0x40,
    isThunk: false,
    isExternal: false,
    hasVarArgs: false,
  } as unknown as ExtractedFunction;
}

/** Six parameters where the slot declares five — the live disagreement. */
const ADPCM_MONO = fn('SCOMP_ADPCMMonoEncode', 'Storm::Source::SSComp',
  ['short *', 'uint32_t *', 'short *', 'uint32_t', 'uint32_t *', 'uint32_t']);
/** Five parameters, but not the slot's five — a type-only disagreement. */
const PKWARE = fn('SCOMP_PKWareImplode', 'Storm::Source::SSComp',
  ['byte *', 'uint32_t *', 'byte *', 'uint32_t', 'void *']);
/** Exactly the slot's contract — nothing to cast. */
const EXACT = fn('SCOMP_ExactMatchEncode', 'Storm::Source::SSComp',
  ['short *', 'short * *', 'int32_t', 'int32_t', 'void *']);

const DATA_TYPES: ExtractedDataType[] = [PFN_SCOMP_CODEC, SCOMP_CODEC_ENTRY, WORD_SLOT_ENTRY];
const FUNCTIONS = [ADPCM_MONO, PKWARE, EXACT];

/** One string constant, so the `(uint)(uintptr_t)s_name` path stays observable. */
const STRINGS = [
  { address: '006cc928', value: 'modstate0', length: 9, encoding: 'string', xrefCount: 1 },
  { address: '006cc920', value: 'modstate1', length: 9, encoding: 'string', xrefCount: 1 },
] as ExtractedString[];

const GLOBALS = [] as unknown as AnalyzedDataSymbol[];

function install(): void {
  setMultidimArrayGlobals([]);
  setKnownFuncDefTypedefs(['pfnSCompCodec']);
  setGlobalInitializerTypes(DATA_TYPES);
  const tables = buildFuncPtrArgCastTables(
    FUNCTIONS, GLOBALS, [PFN_SCOMP_CODEC], DATA_TYPES, STRINGS,
  );
  setInitializerSignatureTables(tables.functionSignatures, tables.funcdefSignatures);
  const addresses = buildGlobalAddressExtentTables(GLOBALS, STRINGS);
  setInitializerAddressTable({
    globalAddresses: addresses.globalAddresses,
    stringConstantNames: addresses.stringConstantNames,
    referenceableNames: new Set(addresses.stringConstantNames),
    imageBase: '0x400000',
  });
}

const entry = (mask: string, codec: string): DataValue => ({
  kind: 'struct',
  fields: [
    { name: 'dwMethodMask', value: { kind: 'scalar', value: mask } },
    { name: 'pfnCodec', value: { kind: 'pointer', value: codec } },
  ],
});

describe('a function address stored in a differing function-pointer slot', () => {
  beforeEach(install);

  it('casts to the slot type when the ARITY differs', () => {
    const out = emitDataValue(
      entry('0x40', 'Storm::Source::SSComp::SCOMP_ADPCMMonoEncode'), 0, 'SCompCodecEntryStrc');
    assert.ok(
      out.includes('(pfnSCompCodec)&Storm::Source::SSComp::SCOMP_ADPCMMonoEncode'),
      `expected the slot-typed cast in: ${out}`,
    );
  });

  it('still counts the arity disagreement it now casts', () => {
    emitDataValue(
      entry('0x40', 'Storm::Source::SSComp::SCOMP_ADPCMMonoEncode'), 0, 'SCompCodecEntryStrc');
    assert.strictEqual(getInitializerFuncPtrArityMismatches(), 1);
  });

  it('counts it once, though the globals units are rendered twice', () => {
    // `generateGlobalsHeader` resolves the central initializers ahead of itself,
    // to learn which symbols they name before the closure has to declare them.
    // That pass renders the same trees the units will render, so the count it
    // walks past is the SAME disagreement, not a second one. The number goes to
    // the database owner as work to do; doubling it would be a lie about how
    // much there is.
    const global = {
      name: 'gaSCompCodecTable', address: '006cc960', dataType: 'SCompCodecEntryStrc',
      suggestedType: 'SCompCodecEntryStrc', size: 8, isInitialized: true,
      initializedData: entry('0x40', 'Storm::Source::SSComp::SCOMP_ADPCMMonoEncode'),
      xrefCount: 1, scope: 'global',
    } as unknown as AnalyzedDataSymbol;
    recordCentralInitializerAddressReferences([global]);
    assert.strictEqual(getInitializerFuncPtrArityMismatches(), 0,
      'discovery is not emission — it counts nothing');
    emitDataValue(global.initializedData!, 0, 'SCompCodecEntryStrc');
    assert.strictEqual(getInitializerFuncPtrArityMismatches(), 1);
  });

  it('casts to the slot type when only the parameter TYPES differ', () => {
    const out = emitDataValue(
      entry('0x8', 'Storm::Source::SSComp::SCOMP_PKWareImplode'), 0, 'SCompCodecEntryStrc');
    assert.ok(
      out.includes('(pfnSCompCodec)&Storm::Source::SSComp::SCOMP_PKWareImplode'),
      `expected the slot-typed cast in: ${out}`,
    );
  });

  it('leaves a function whose prototype MATCHES the slot uncast', () => {
    const out = emitDataValue(
      entry('0x1', 'Storm::Source::SSComp::SCOMP_ExactMatchEncode'), 0, 'SCompCodecEntryStrc');
    assert.ok(
      out.includes('&Storm::Source::SSComp::SCOMP_ExactMatchEncode'),
      `expected the plain address in: ${out}`,
    );
    assert.ok(!out.includes('(pfnSCompCodec)'), `no cast is needed in: ${out}`);
  });

  it('names the same symbol either way — a cast changes the type, never the target', () => {
    for (const [name, mask] of [
      ['SCOMP_ADPCMMonoEncode', '0x40'],
      ['SCOMP_PKWareImplode', '0x8'],
      ['SCOMP_ExactMatchEncode', '0x1'],
    ]) {
      const out = emitDataValue(
        entry(mask, `Storm::Source::SSComp::${name}`), 0, 'SCompCodecEntryStrc');
      const referenced = [...out.matchAll(/&([A-Za-z_][\w:]*)/g)].map(m => m[1]);
      assert.deepStrictEqual(referenced, [`Storm::Source::SSComp::${name}`], out);
    }
  });

  it('leaves a null codec slot as nullptr', () => {
    const out = emitDataValue(entry('0x0', '0x0'), 0, 'SCompCodecEntryStrc');
    assert.ok(out.includes('nullptr'), `expected nullptr in: ${out}`);
    assert.ok(!out.includes('(pfnSCompCodec)'), `a null slot takes no cast: ${out}`);
  });

  it('routes a function address in an INTEGER slot through uintptr_t', () => {
    const out = emitDataValue({
      kind: 'struct',
      fields: [
        { name: 'dwMethodMask', value: { kind: 'scalar', value: '0x40' } },
        { name: 'dwCodec', value: { kind: 'pointer', value: 'Storm::Source::SSComp::SCOMP_ADPCMMonoEncode' } },
      ],
    }, 0, 'SCompWordSlotStrc');
    assert.ok(
      out.includes('(uint32_t)(uintptr_t)&Storm::Source::SSComp::SCOMP_ADPCMMonoEncode'),
      `expected the integral spelling in: ${out}`,
    );
  });

  it('does not disturb the string-address spelling in an integral slot', () => {
    const out = emitDataValue({
      kind: 'array',
      elements: [
        { kind: 'scalar', value: '0x6cc928' },
        { kind: 'scalar', value: '0x6cc920' },
      ],
    }, 0, 'uint[2]');
    assert.ok(
      out.includes('(uint)(uintptr_t)s_modstate0_006cc928'),
      `expected the string spelling in: ${out}`,
    );
  });
});

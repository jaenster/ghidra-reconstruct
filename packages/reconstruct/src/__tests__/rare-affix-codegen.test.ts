/**
 * The loop excerpts are transcribed from the Windows 1.14d Redivivus
 * decompiles at 0x00633f40 and 0x00637500. Drive them through the real project
 * pipeline so strided-access and the late counted-loop pass must cooperate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { generateProject } from '../codegen/index.js';
import type {
  AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction, ExtractedStruct,
  ExtractedNamespace, ProgramInfo, ReconstructOptions,
} from '../types.js';

const options: ReconstructOptions = {
  outputDir: './out', format: 'cpp', organization: 'namespace',
  generateCMake: false, generateSourceMaps: false, transformPreset: 'full',
  includeAddressComments: false, promoteStaticGlobals: false,
};

const programInfo: ProgramInfo = {
  name: 'Game.exe', path: '/tmp/Game.exe', format: 'PE',
  architecture: 'x86', compiler: 'msvc', imageBase: '0x400000',
  languageId: 'x86:LE:32:default', endianness: 'little', pointerSize: 4,
};

const dataTypes: ExtractedDataType[] = [
  {
    kind: 'STRUCTURE', name: 'D2RareAffixTableStrc', category: '/D2Common', size: 16,
    fields: [
      { name: 'nSize', dataType: 'int', offset: 0, size: 4 },
      { name: 'pTable', dataType: 'D2RareAffixTxt *', offset: 4, size: 4 },
      { name: 'pSuffixStart', dataType: 'D2RareAffixTxt *', offset: 8, size: 4 },
      { name: 'pPrefixStart', dataType: 'D2RareAffixTxt *', offset: 12, size: 4 },
    ],
  } as ExtractedStruct,
  {
    kind: 'STRUCTURE', name: 'D2RareAffixTxt', category: '/Diablo2/TXT/TXT Tables', size: 72,
    fields: [
      { name: 'wNameStrId', dataType: 'uint16_t', offset: 12, size: 2 },
      { name: 'name', dataType: 'char[32]', offset: 38, size: 32 },
    ],
  } as ExtractedStruct,
  {
    kind: 'STRUCTURE', name: 'D2LowQualityItemsTableStrc', category: '/D2Common', size: 8,
    fields: [
      { name: 'nSize', dataType: 'int', offset: 0, size: 4 },
      { name: 'pTable', dataType: 'D2LowQualityItemsTxt *', offset: 4, size: 4 },
    ],
  } as ExtractedStruct,
  {
    kind: 'STRUCTURE', name: 'D2LowQualityItemsTxt', category: '/Diablo2/TXT/TXT Tables', size: 34,
    fields: [
      { name: 'Name', dataType: 'char[32]', offset: 0, size: 32 },
      { name: 'wNameStringId', dataType: 'uint16_t', offset: 32, size: 2 },
    ],
  } as ExtractedStruct,
];

const globals: AnalyzedDataSymbol[] = [
  {
    name: 'gsRareAffixTable', address: '0096caa0', dataType: 'D2RareAffixTableStrc',
    size: 16, isInitialized: false, xrefCount: 4, scope: 'global',
    namespace: 'D2Common::DATATBLS::ItemTbls',
  },
  {
    name: 'nTxtLowQualityItemsSize', address: '0096cc58', dataType: 'D2LowQualityItemsTableStrc',
    size: 8, isInitialized: false, xrefCount: 4, scope: 'global',
    namespace: 'D2Common::DATATBLS::ItemTbls',
  },
];

function extracted(name: string, address: string, decompiled: string): ExtractedFunction {
  return {
    name, address, signature: `void ${name}(D2PoolManagerStrc * pMemory)`,
    returnType: 'void', parameters: [
      { name: 'pMemory', dataType: 'D2PoolManagerStrc *', size: 4, ordinal: 0 },
    ],
    localVariables: [], callingConvention: '__fastcall', size: 0x30,
    isThunk: false, isExternal: false, hasVarArgs: false,
    namespace: 'D2Common::DATATBLS::ItemTbls', decompiled, calledFunctions: [],
  };
}

const rare = extracted('TXT_AllocTxt_RareAffixes', '0x00633f40', `
void __fastcall D2Common::DATATBLS::ItemTbls::TXT_AllocTxt_RareAffixes(D2PoolManagerStrc *pMemory)
{
  uint32_t nStringId;
  int nByteOffset;
  int nIdx;
  WCHAR *pStringOut;
  nByteOffset = 0;
  pStringOut = (WCHAR *)0x0;
  if (0 < gsRareAffixTable.nSize) {
    nIdx = 0;
    do {
      nStringId = D2Lang::StrTable::strtable::STRTABLE_LookupString
                            ((byte *)((gsRareAffixTable.pTable)->name + nByteOffset),&pStringOut);
      *(short *)((gsRareAffixTable.pTable)->name + nByteOffset + -0x1a) = (short)nStringId;
      nIdx = nIdx + 1;
      nByteOffset = nByteOffset + 0x48;
    } while (nIdx < gsRareAffixTable.nSize);
  }
  return;
}`);

const low = extracted('TXT_AllocTxt_lowqualityitems', '0x00637500', `
void __fastcall D2Common::DATATBLS::ItemTbls::TXT_AllocTxt_lowqualityitems(D2PoolManagerStrc *pMemory)
{
  uint32_t nStringId;
  int nLowQualSize;
  int nIdx;
  WCHAR *pStringOut;
  nLowQualSize = 0;
  nIdx = 0;
  pStringOut = (WCHAR *)0x0;
  if (0 < nTxtLowQualityItemsSize.nSize) {
    do {
      nStringId = D2Lang::StrTable::strtable::STRTABLE_LookupString
                            ((byte *)((nTxtLowQualityItemsSize.pTable)->Name + nLowQualSize),
                             &pStringOut);
      *(short *)((nTxtLowQualityItemsSize.pTable)->Name + nLowQualSize + 0x20) = (short)nStringId;
      nIdx = nIdx + 1;
      nLowQualSize = nLowQualSize + 0x22;
    } while (nIdx < nTxtLowQualityItemsSize.nSize);
  }
  return;
}`);

const namespaces: ExtractedNamespace[] = [
  { name: 'ItemTbls', fullPath: 'D2Common::DATATBLS::ItemTbls', functionCount: 2, isClass: false },
];

function bodyFor(impl: string, name: string): string {
  const start = impl.indexOf(`void __fastcall ${name}(`);
  assert.ok(start >= 0, `missing ${name} implementation`);
  const open = impl.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < impl.length; i++) {
    if (impl[i] === '{') depth++;
    if (impl[i] === '}' && --depth === 0) return impl.slice(open, i + 1);
  }
  throw new Error(`unclosed ${name} implementation`);
}

describe('RareAffixes full codegen', () => {
  it('recovers the rare loop after stride folding and leaves lowqualityitems guarded', () => {
    const project = generateProject(
      'rare-affix', [rare, low], [], dataTypes, globals, namespaces, options, programInfo,
    );
    const impl = [...project.files.values()]
      .filter(file => file.type === 'implementation')
      .map(file => file.content).join('\n');
    const rareBody = bodyFor(impl, rare.name);
    const lowBody = bodyFor(impl, low.name);
    assert.match(rareBody, /gsRareAffixTable\.pTable\[nIdx\]\.name/);
    assert.doesNotMatch(rareBody, /\bnByteOffset\b/);
    assert.match(rareBody, /for \(int nIdx = 0; nIdx < gsRareAffixTable\.nSize; nIdx\+\+\)/);
    assert.doesNotMatch(rareBody, /\bdo \{/);
    assert.match(lowBody, /\bdo \{/);
    assert.doesNotMatch(lowBody, /\bfor \(/);
  });
});

import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parse,
  NodeKind,
  findNodesByKind,
  type BinaryExpr,
  type IntegerLiteralExpr,
} from '@ghidra-mcp/cpp-parser';
import { generateFunctionImplementation } from '../codegen/impl.js';
import type { ExtractedFunction, ReconstructOptions } from '../types.js';

const decompiled = JSON.parse(
  readFileSync(
    new URL(
      '../../../cpp-parser/src/transform/plugins/__tests__/fixtures/word-memcmp-shared.json',
      import.meta.url,
    ),
    'utf8',
  ),
).code as string;
const comparisons = findNodesByKind(parse(decompiled), NodeKind.BinaryExpr)
  .map((n) => n as BinaryExpr)
  .filter((n) => ['<', '<=', '>', '>=', '==', '!='].includes(n.operator))
  .sort((a, b) => a.right.location!.start.offset - b.right.location!.start.offset);
// Manually attested from the original CMP/Jcc pairs. Other token rows have no
// facts. This fixture is not a run of the owning Ghidra markup extractor.
const compareSites = comparisons
  .map((n, ord) => {
    const k =
      n.left.kind === NodeKind.IntegerLiteral ? (n.left as IntegerLiteralExpr).value.toString(16) : '';
    const facts: Record<string, string[]> = {
      '1ff': ['INT_SLESS', 'v:nSize', '00478359', '00478364', 'JL', '200'],
      c7: ['INT_LESS', 'e', '0047845e', '00478463', 'JNC', 'c8'],
      '31': ['INT_LESS', 'e', '004783b5', '004783b8', 'JNC', '32'],
    };
    if (n.operator !== '<' || !facts[k]) return `${ord}\t${n.operator}\t-`;
    const [op, fp, at, user, cc, b] = facts[k];
    return [ord, n.operator, op, 4, 0, k, 'c:' + k, fp, at, user, cc, at, 'CMP', 4, 'r', 'i', b, 1].join(
      '\t',
    );
  })
  .join('\n');
const fn: ExtractedFunction = {
  name: 'NET_D2GS_CLIENT_Send',
  address: '00478350',
  namespace: 'D2Client::GAME::Msg',
  signature: 'void NET_D2GS_CLIENT_Send(byte *pBytes,int32_t nSize)',
  returnType: 'void',
  callingConvention: '__stdcall',
  size: 499,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  localVariables: [],
  decompiled,
  compareSites,
  parameters: [
    { name: 'pBytes', dataType: 'byte*', size: 4, ordinal: 0, storage: 'Stack[0x4]:4' },
    { name: 'nSize', dataType: 'int32_t', size: 4, ordinal: 1, storage: 'EDI:4' },
  ],
};
const options: ReconstructOptions = {
  outputDir: './out',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};
const tables = {
  paramFuncdefs: {},
  funcdefSignatures: {},
  functionSignatures: {},
  variableNames: [],
  voidPointerFunctions: [],
  rootQualifiedTypedefs: [],
  typedefTargets: {
    byte: 'unsigned char',
    uint: 'unsigned int',
    uint32_t: 'unsigned int',
    int32_t: 'int',
    DWORD: 'unsigned int',
  },
};

it('full codegen recovers both memcmps and preserves the three surviving comparison ties', () => {
  const text = generateFunctionImplementation(fn, undefined, options, {
    funcPtrArgCasts: {
      ...tables,
      globalTypes: { gaLastSentPacketBuffer: 'char[512]', gdwLastPacketSendTick: 'unsigned int' },
    },
  });
  assert.equal((text.match(/::memcmp\(/g) ?? []).length, 2);
  assert.match(text, /nSize >= 0x200/);
  assert.match(text, /dwTick - gdwLastPacketSendTick >= 0x32/);
  assert.match(text, /dwTick - gdwLastPacketSendTick >= 200/);
  assert.doesNotMatch(text, /goto (bytes_equal|bytes_differ|cmp_bytes|skill_cmp_bytes)/);
});

it('full codegen leaves the word loops when the cache array type is unavailable', () => {
  const text = generateFunctionImplementation(fn, undefined, options, { funcPtrArgCasts: tables });
  assert.doesNotMatch(text, /::memcmp\(/);
  assert.equal((text.match(/for \(nRemaining/g) ?? []).length, 2);
});

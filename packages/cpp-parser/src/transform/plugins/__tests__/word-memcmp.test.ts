import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import { pseudoOpLowerPlugin, type PseudoOpLowerOptions } from '../builtins/pseudo-op-lower.js';
import { compileAndRun, hasNativeGpp } from '../../../testing/native-cpp.js';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/word-memcmp-shared.json', import.meta.url), 'utf8'),
).code as string;
const options: PseudoOpLowerOptions = {
  globalTypes: { gaLastSentPacketBuffer: 'char[512]' },
  typedefTargets: {
    byte: 'unsigned char',
    uint: 'unsigned int',
    uint32_t: 'unsigned int',
    int32_t: 'int',
    DWORD: 'unsigned int',
  },
};
function run(code = fixture, opts: PseudoOpLowerOptions = options): string {
  return emit(pseudoOpLowerPlugin.createTransformer(opts)(parse(code)) as never);
}
it('recovers both word/byte comparisons with their shared tail', () => {
  const out = run();
  assert.equal((out.match(/::memcmp\(/g) ?? []).length, 2, out);
  assert.doesNotMatch(out, /for \(nRemaining/);
});

it('does not depend on function, variable, label, or address spellings', () => {
  let code = fixture;
  const names = [...new Set(code.match(/\b[A-Za-z_]\w*\b/g))].filter((n) =>
    /^(nRemaining|nCmpResult|pLastBuf|pCurBytes|nByteDiff|pBytes|nSize|gaLastSentPacketBuffer|bytes_equal|bytes_differ|cmp_bytes|skill_cmp_bytes|test_byte3_diff|record_and_send|switchD_004783a6_caseD_5|NET_D2GS_CLIENT_Send)$/.test(
      n,
    ),
  );
  const renames = Object.fromEntries(names.map((n, i) => [n, `renamed_${i}`]));
  code = code.replace(/\b[A-Za-z_]\w*\b/g, (n) => renames[n] ?? n);
  const out = run(code, { ...options, globalTypes: { [renames.gaLastSentPacketBuffer]: 'char[512]' } });
  assert.equal((out.match(/::memcmp\(/g) ?? []).length, 2);
});

it('is idempotent', () => {
  const once = run();
  assert.equal(run(once), once);
});

it('accepts a unique local array without global metadata', () => {
  const code = fixture.replace('void *nErrAddr;', 'char gaLastSentPacketBuffer[512] = {0}; void *nErrAddr;');
  assert.equal((run(code, { ...options, globalTypes: {} }).match(/::memcmp\(/g) ?? []).length, 2);
});

it('refuses a valid outer switch entry into the shared tail even with two array inputs', () => {
  let code = fixture
    .replace('byte *pBytes,int32_t nSize', 'byte *ignored,int32_t nSize')
    .replace('void *nErrAddr;', 'byte pBytes[512] = {0}; void *nErrAddr;')
    .replace('  if (0x1ff < nSize)', '  switch(nSize) { case 0: if (0x1ff < nSize)');
  const end = code.lastIndexOf('}');
  code = code.slice(0, end) + '}\n' + code.slice(end);
  assert.equal((run(code).match(/::memcmp\(/g) ?? []).length, 2);
  assert.doesNotMatch(run(code.replace('bytes_differ:\n', 'case 99: bytes_differ:\n')), /::memcmp\(/);
});

it('preserves a constant return value', () => {
  const code = fixture.replace(/^void /, 'int ').replace(/return;/g, 'return 7;');
  const out = run(code);
  assert.equal((out.match(/::memcmp\(/g) ?? []).length, 2);
  assert.match(out, /::memcmp\([^\n]+ == 0\)/);
  assert.match(out, /return 7;/);
});

it('accepts the equivalent >= 4 word condition and compound strides', () => {
  const code = fixture
    .replace(/3 < nRemaining/g, 'nRemaining >= 4')
    .replace(/nRemaining = nRemaining - 4/g, 'nRemaining -= 4')
    .replace(/pCurBytes = pCurBytes \+ 4/g, 'pCurBytes += 4')
    .replace(/pLastBuf = pLastBuf \+ 4/g, 'pLastBuf += 4');
  assert.equal((run(code).match(/::memcmp\(/g) ?? []).length, 2);
});

const refuses: Array<[string, (code: string) => string, PseudoOpLowerOptions?]> = [
  [
    'an early return on mismatch without a full-range contract',
    (c) => c.replace('if (nCmpResult == 0)', 'if (nCmpResult != 0)'),
  ],
  [
    'a missing range copy on mismatch',
    (c) => c.replace('compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize);', 'observe();'),
  ],
  [
    'a conditional range copy on mismatch',
    (c) =>
      c.replace(
        'compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize);',
        'if (nSize) compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize);',
      ),
  ],
  [
    'a range copy with another length',
    (c) =>
      c.replace(
        'compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize);',
        'compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize-1);',
      ),
  ],
  [
    'a range copy with another input',
    (c) =>
      c.replace(
        'compiler::memcpy(gaLastSentPacketBuffer,pBytes,nSize);',
        'compiler::memcpy(gaLastSentPacketBuffer,otherBytes,nSize);',
      ),
  ],
  [
    'unknown work before the range copy',
    (c) => c.replace('dwTickSnapshot = dwTick;', 'side_effect(); dwTickSnapshot = dwTick;'),
  ],
  [
    'a length changed before the range copy',
    (c) => c.replace('dwTickSnapshot = dwTick;', 'nSize = 1; dwTickSnapshot = dwTick;'),
  ],
  [
    'an escaped input length',
    (c) => c.replace('dwTick = GetTickCount();', 'consume(&nSize); dwTick = GetTickCount();'),
  ],
  ['changed word stride', (c) => c.replace('pCurBytes = pCurBytes + 4', 'pCurBytes = pCurBytes + 8')],
  ['changed count stride', (c) => c.replace('nRemaining = nRemaining - 4', 'nRemaining = nRemaining - 8')],
  ['changed word width', (c) => c.replace('*(int *)pLastBuf', '*(short *)pLastBuf')],
  ['changed word predicate', (c) => c.replace('*(int *)pLastBuf !=', '*(int *)pLastBuf ==')],
  ['changed byte offset', (c) => c.replace('(uint)pCurBytes[2]', '(uint)pCurBytes[3]')],
  [
    'changed byte order',
    (c) =>
      c.replace(
        '(uint)(byte)pLastBuf[1] - (uint)pCurBytes[1]',
        '(uint)pCurBytes[1] - (uint)(byte)pLastBuf[1]',
      ),
  ],
  ['changed remainder test', (c) => c.replace('nRemaining != 2', 'nRemaining != 1')],
  ['changed equal result', (c) => c.replace('nCmpResult = 0', 'nCmpResult = 1')],
  ['changed differing result', (c) => c.replace('nCmpResult = 1', 'nCmpResult = 0')],
  [
    'a predicate that does not preserve the sign partition',
    (c) => c.replace('nByteDiff < 1', 'nByteDiff == 1'),
  ],
  [
    'a truncated byte tail',
    (c) => c.replace('nByteDiff = (uint)(byte)pLastBuf[3] - (uint)pCurBytes[3];', 'nByteDiff = 0;'),
  ],
  [
    'a call in the word loop',
    (c) => c.replace('pCurBytes = pCurBytes + 4;', 'side_effect(); pCurBytes = pCurBytes + 4;'),
  ],
  ['a call in the tail', (c) => c.replace('bytes_differ:\n', 'bytes_differ:\n    side_effect();\n')],
  [
    'a result used outside the recovered region',
    (c) => c.replace('dwTickSnapshot = dwTick;', 'consume(nCmpResult); dwTickSnapshot = dwTick;'),
  ],
  [
    'a pointer used outside the recovered region',
    (c) => c.replace('dwTickSnapshot = dwTick;', 'consume(pLastBuf); dwTickSnapshot = dwTick;'),
  ],
  [
    'an outside goto into the shared tail',
    (c) =>
      c.replace('dwTick = GetTickCount();', 'dwTick = GetTickCount(); if (nSize == 7) goto bytes_differ;'),
  ],
  [
    'an outside goto into an otherwise impossible branch',
    (c) =>
      c
        .replace('dwTick = GetTickCount();', 'dwTick = GetTickCount(); if (nSize == 7) goto extra_entry;')
        .replace(
          'if (nByteDiff == 0) goto bytes_equal;',
          'if (nByteDiff == 0) { extra_entry: goto bytes_equal; }',
        ),
  ],
  [
    'an outside goto into the word body',
    (c) =>
      c
        .replace('dwTick = GetTickCount();', 'dwTick = GetTickCount(); if (nSize == 7) goto extra_entry;')
        .replace('    pCurBytes = pCurBytes + 4;', 'extra_entry: pCurBytes = pCurBytes + 4;'),
  ],
  ['an outside switch case into the tail', (c) => c.replace('bytes_differ:\n', 'case 99: bytes_differ:\n')],
  ['a volatile count', (c) => c.replace('uint nRemaining;', 'volatile uint nRemaining;')],
  ['a volatile input length', (c) => c.replace('int32_t nSize)', 'volatile int32_t nSize)')],
  ['a volatile pointer', (c) => c.replace('byte *pCurBytes;', 'volatile byte *pCurBytes;')],
  ['a volatile word load', (c) => c.replace('*(int *)pLastBuf', '*(volatile int *)pLastBuf')],
  [
    'a typedef hiding a volatile word load',
    (c) => c.replace('*(int *)pLastBuf', '*(VolatileWord *)pLastBuf'),
    { ...options, typedefTargets: { ...options.typedefTargets, VolatileWord: 'volatile int' } },
  ],
  [
    'a typedef hiding volatile input bytes',
    (c) => c.replace('byte *pBytes', 'VolatileByte *pBytes'),
    { ...options, typedefTargets: { ...options.typedefTargets, VolatileByte: 'volatile unsigned char' } },
  ],
  ['a volatile byte cast', (c) => c.replace('(uint)(byte)*pLastBuf', '(uint)(volatile byte)*pLastBuf')],
  [
    'a volatile global array',
    (c) => c,
    { ...options, globalTypes: { gaLastSentPacketBuffer: 'volatile char[512]' } },
  ],
  [
    'an alias hiding volatile global array elements',
    (c) => c,
    {
      ...options,
      globalTypes: { gaLastSentPacketBuffer: 'HiddenByte[512]' },
      typedefTargets: { ...options.typedefTargets, HiddenByte: 'InnerByte', InnerByte: 'volatile char' },
    },
  ],
  ['a signed loop count', (c) => c.replace('uint nRemaining;', 'int nRemaining;')],
  ['a 64-bit input length', (c) => c.replace('int32_t nSize)', 'long long nSize)')],
  ['a temporary initializer', (c) => c.replace('int nByteDiff;', 'int nByteDiff = 0;')],
  [
    'a shadowed temporary',
    (c) =>
      c.replace(
        'dwTick = GetTickCount();',
        '{ int nRemaining; consume(nRemaining); } dwTick = GetTickCount();',
      ),
  ],
  [
    'a temporary reused as a later length input',
    (c) => c.replace(/nRemaining = nSize/g, 'nRemaining = nCmpResult'),
  ],
  ['a pointer input without a dominating dereference', (c) => c.replace('switch(*pBytes)', 'switch(nSize)')],
  ['a conditional input dereference', (c) => c.replace('if (true) {', 'if (nSize != 0) {')],
  [
    'a pointer changed after its dominating dereference',
    (c) => c.replace('if (199 <', 'pBytes = otherBytes; if (199 <'),
  ],
  [
    'an escaped pointer input',
    (c) => c.replace('dwTick = GetTickCount();', 'consume(&pBytes); dwTick = GetTickCount();'),
  ],
  ['an unproved global pointer', (c) => c, { ...options, globalTypes: { gaLastSentPacketBuffer: 'char*' } }],
  ['missing global array metadata', (c) => c, { ...options, globalTypes: {} }],
  [
    'a local pointer hiding global array metadata',
    (c) => c.replace('void *nErrAddr;', 'char *gaLastSentPacketBuffer; void *nErrAddr;'),
  ],
  [
    'a pointer shadowing a local byte array',
    (c) =>
      c.replace(
        'void *nErrAddr;',
        '{ char gaLastSentPacketBuffer[512]; } char *gaLastSentPacketBuffer; void *nErrAddr;',
      ),
  ],
  ['a local memcmp declaration', (c) => c.replace('void *nErrAddr;', 'int memcmp; void *nErrAddr;')],
];
for (const [name, mutate, opts] of refuses)
  it(`refuses ${name}`, () => {
    const out = run(mutate(fixture), opts ?? options);
    assert.doesNotMatch(out, /::memcmp\(/, out);
  });

it('preserves packet payloads, throttling, counters and halt behavior', { skip: !hasNativeGpp() }, () => {
  const declarations = `
    #include <array>
    #include <vector>
    #include <cstdlib>
    using byte=unsigned char; using uint=unsigned int; using DWORD=uint32_t;
    struct Halt {};
    struct Event {
      int size,mode; std::vector<unsigned char> bytes;
      bool operator==(const Event&b) const { return size==b.size&&mode==b.mode&&bytes==b.bytes; }
    };
    std::vector<Event> captures[2]; unsigned active; uint32_t clockTick; bool sendOk;
    DWORD GetTickCount() { return clockTick; }
    namespace compiler { using std::memcpy; [[noreturn]] void exit(int) { std::abort(); } }
    namespace Fog { namespace Src { namespace ErrorManager {
      void* GetInstructionPointer() { return nullptr; }
      [[noreturn]] void ERROR_UnrecoverableInternalError_Halt(const char*,void*,int) { throw Halt{}; }
    }}}
    namespace D2Net { namespace SRC { namespace Client {
      uint32_t NET_D2GS_CLIENT_SendPacketAfterChecks(int n,int mode,char*data) {
        captures[active].push_back({n,mode,std::vector<unsigned char>((byte*)data,(byte*)data+n)});
        return sendOk;
      }
    }}}
  `;
  const functions = [
    ['Before', fixture],
    ['After', run()],
  ]
    .map(
      ([name, code]) => `
    namespace ${name} {
      alignas(4) char gaLastSentPacketBuffer[512]={};
      uint32_t gdwLastPacketSendTick=0,gnD2GSBytesSentTotal=0,gnD2GSPacketsSentTotal=0;
      ${code.replace('D2Client::GAME::Msg::', '')}
    }
  `,
    )
    .join('\n');
  const body = `
    alignas(4) std::array<byte,512> packet{};
    const uint32_t delta[]={0,1,48,49,50,51,198,199,200,201,0xffffff00u};
    clockTick=0xfffffff0u; unsigned checks=0;
    for (unsigned group=0;group<256*512;++group) {
      unsigned length=group%512,opcode=group/512;
      for (unsigned j=0;j<512;++j) packet[j]=(byte)(group*17u+j*29u+(j>>2));
      packet[0]=(byte)opcode;
      for (unsigned repeat=0;repeat<4;++repeat) {
        if (repeat==2&&length>1) packet[1+(group%(length-1))]^=0x80;
        clockTick+=delta[(group+repeat)%11]; sendOk=(group+repeat)%7!=0;
        int size=repeat==3&&group%257==0?512:(int)length;
        bool halted[2]={false,false};
        for (active=0;active<2;++active) {
          captures[active].clear();
          try {
            if (active==0) Before::NET_D2GS_CLIENT_Send(packet.data(),size);
            else After::NET_D2GS_CLIENT_Send(packet.data(),size);
          } catch (Halt&) { halted[active]=true; }
        }
        if (halted[0]!=halted[1]||captures[0]!=captures[1]
          ||Before::gnD2GSBytesSentTotal!=After::gnD2GSBytesSentTotal
          ||Before::gnD2GSPacketsSentTotal!=After::gnD2GSPacketsSentTotal) return 1;
        ++checks;
      }
    }
    std::printf("checks=%u\\n",checks);
  `;
  // The reference is the existing MSVC word-load idiom, which permits byte
  // buffers to be read through int*. Preserve that aliasing model in this test.
  assert.equal(
    compileAndRun(declarations + functions, body, { optimize: true, flags: ['-fno-strict-aliasing'] }),
    'checks=524288\n',
  );
});

/**
 * Golden: a constructor handed to the compiler's array iterator, whose return value the
 * iterator drops. The calls are the Game.exe decompiles (program v2071) of
 * StaticInit_aTaskQueueCriticalSections 006caf90 and HUFFMAN_InitContext 0041f4a0.
 * InitCriticalSection 0040eb50 and LINKEDLIST_LinkBefore 0041ee80 return the object they
 * were given (`MOV EAX,ECX`); once the database says so (proposals 2270, 2271, 2278) the
 * slot `void (__fastcall *)(void*)` no longer takes them without the cast.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { funcPtrArgCastPlugin } from '../builtins/funcptr-arg-cast.js';

const SLOT = { returnType: 'void', paramTypes: ['void*'], convention: '__fastcall' };
const CTOR = 'Fog::Src::LogManager::InitCriticalSection';
const LINK = 'Storm::Source::SComp::LINKEDLIST_LinkBefore';
const DTOR = 'Fog::THREADING_DeleteCriticalSection_Thunk';
const NODE_DTOR = 'Storm::Source::SComp::LINKEDLIST_NodeDestructor';

function tables(over: Record<string, { ret: string; params: string[]; conv?: string }>) {
  const fns: Record<string, { ret: string; params: string[]; conv?: string }> = {
    [CTOR]: { ret: 'void', params: ['void *'] },
    [LINK]: { ret: 'void', params: ['void *'] },
    [DTOR]: { ret: 'void', params: ['void *'] },
    [NODE_DTOR]: { ret: 'void', params: ['void *'] },
    ...over,
  };
  const both = <T>(f: (v: typeof fns[string]) => T) => Object.fromEntries(Object.entries(fns)
    .flatMap(([k, v]) => [[k, f(v)], [k.replace(/^.*::/, ''), f(v)]]));
  return {
    paramFuncdefs: {}, funcdefSignatures: {},
    functionSignatures: both(v => `${v.ret}(${v.params.join(', ')})`),
    functionParamTypes: both(v => v.params),
    functionReturnTypes: both(v => v.ret),
    functionConventions: both(v => v.conv ?? '__fastcall'),
    discardedReturnCallbackCasts: {
      _eh_vector_constructor_iterator_: { 3: SLOT, 4: SLOT },
      _eh_vector_destructor_iterator_: { 3: SLOT },
    },
  };
}

const TASK = `void StaticInit_aTaskQueueCriticalSections(void) {
  compiler::_eh_vector_constructor_iterator_
            (aTaskQueueCriticalSections,0x18,0x20,Fog::Src::LogManager::InitCriticalSection,
             Fog::THREADING_DeleteCriticalSection_Thunk);
}`;
const HUFF = `D2CompressEncoderStrc * __fastcall HUFFMAN_InitContext(D2CompressEncoderStrc *pEncoder) {
  compiler::_eh_vector_constructor_iterator_
            (pEncoder->aNodePool,0x18,0x203,Storm::Source::SComp::LINKEDLIST_LinkBefore,
             Storm::Source::SComp::LINKEDLIST_NodeDestructor);
  return pEncoder;
}`;

function run(code: string, over: Parameters<typeof tables>[0] = {}): string {
  return emit(funcPtrArgCastPlugin.createTransformer(tables(over))(parse(code)) as AnyNode).replace(/\s+/g, ' ');
}

describe('Golden: a constructor whose return the array iterator drops', () => {
  it('InitCriticalSection 0040eb50 returning its CRITICAL_SECTION is cast to the slot', () => {
    const out = run(TASK, { [CTOR]: { ret: 'CRITICAL_SECTION *', params: ['CRITICAL_SECTION *'] } });
    assert.match(out, /\(void \(__fastcall \*\)\(void\*\)\)Fog::Src::LogManager::InitCriticalSection/, out);
    assert.doesNotMatch(out, /\)\)Fog::THREADING_DeleteCriticalSection_Thunk/, out);
  });

  it('LINKEDLIST_LinkBefore 0041ee80 returning void * is cast (proposal 2270)', () => {
    const out = run(HUFF, { [LINK]: { ret: 'void *', params: ['void *'] } });
    assert.match(out, /\(void \(__fastcall \*\)\(void\*\)\)Storm::Source::SComp::LINKEDLIST_LinkBefore/, out);
  });

  it('a constructor that already is the slot\'s prototype stays as printed', () => {
    const out = run(TASK);
    assert.doesNotMatch(out, /__fastcall \*/, out);
  });

  it('refuses another convention, another arity or a non-pointer parameter', () => {
    for (const fn of [
      { ret: 'void *', params: ['void *'], conv: '__thiscall' },
      { ret: 'void *', params: ['void *', 'int'] },
      { ret: 'void *', params: ['int'] },
    ]) {
      const out = run(TASK, { [CTOR]: fn });
      assert.doesNotMatch(out, /__fastcall \*/, `${JSON.stringify(fn)}: ${out}`);
    }
  });
});

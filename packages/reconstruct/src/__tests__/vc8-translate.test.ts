import { describe, it } from 'node:test';
import assert from 'node:assert';

import { fileFacts, mergeFacts, withoutNonWin32 } from '../vc8/facts.js';
import { applyPatches, functionAt, PLATFORM_H, translate } from '../vc8/translate.js';

/** Translate `rel` of a small tree: the pre-pass runs over every file given. */
function tr(files: Record<string, string>, rel: string, quarantine?: number[]): string {
  const state = mergeFacts(Object.entries(files).map(([p, t]) => fileFacts(t, p.endsWith('.h'), p)));
  return translate(files[rel], rel, state, quarantine);
}

function one(text: string, rel = 'a.cpp'): string {
  return tr({ [rel]: text }, rel);
}

describe('vc8 translate: syntax VC8 lacks', () => {
  it('splits a nested namespace definition and its close', () => {
    assert.equal(one('namespace A::B {\nint x;\n} // namespace A::B\n'),
      'namespace A { namespace B {\nint x;\n}} // namespace A::B\n');
  });

  it('wraps a packed struct in pack pragmas', () => {
    assert.equal(one('struct __attribute__((packed)) S {\n  char c;\n  int i;\n};\n'),
      '__pragma(pack(push, 1)) struct S {\n  char c;\n  int i;\n}; __pragma(pack(pop))\n');
  });

  it('drops the packed attribute of a declaration', () => {
    assert.equal(one('struct __attribute__((packed)) S;\n'), 'struct S;\n');
  });

  it('spells noinline as a declspec', () => {
    assert.equal(one('__attribute__((noinline)) void f();\n'), '__declspec(noinline) void f();\n');
  });

  it('blanks a defaulted constructor, or spells it when there are others', () => {
    assert.equal(one('struct S {\n  S() = default;\n  int x;\n};\n'), 'struct S {\n  \n  int x;\n};\n');
    assert.equal(one('struct S {\n  S() = default;\n  S(int v) : x(v) {}\n  int x;\n};\n'),
      'struct S {\n  S() {}\n  S(int v) : x(v) {}\n  int x;\n};\n');
  });

  it('turns direct-list-initialisation into a constructor call', () => {
    assert.equal(one('void f() {\n      D2SehScope __seh0{1};\n}\n'), 'void f() {\n      D2SehScope __seh0(1);\n}\n');
  });

  it('zeroes an empty-brace assignment with memset', () => {
    assert.equal(one('void f() {\n  s.a[2] = {};\n}\n'), 'void f() {\n  memset(&(s.a[2]), 0, sizeof(s.a[2]));\n}\n');
  });

  it('blanks a template static member declaration in a header only', () => {
    const text = 'template<> void * T<A, 0>::vftable[4];\nint y;\n';
    assert.equal(one(text, 'a.h'), '\nint y;\n');
    assert.equal(one(text, 'a.cpp'), text);
  });

  it('writes binary literals in hex', () => {
    assert.equal(one('int x = 0b1010u;\n'), 'int x = 0xau;\n');
    assert.equal(one('int x = 0b11111111111111111000111111111111U;\n'), 'int x = 0xffff8fffU;\n');
  });

  it('removes C++11 attributes', () => {
    assert.equal(one('[[nodiscard]] int f();\n'), 'int f();\n');
  });

  it('moves a leading calling convention after the return type', () => {
    assert.equal(one('extern "C" __stdcall void* SmackOpen(const char* szName);\n'),
      'extern "C" void* __stdcall SmackOpen(const char* szName);\n');
  });

  it('gives an empty braced initialiser one element', () => {
    assert.equal(one('struct P { int a; };\nP p = {};\n'), 'struct P { int a; };\nP p = {0};\n');
  });

  it('leaves comments and strings alone', () => {
    const text = 'namespace N {\n// calls f(a, b) __thiscall, 0b11 [[arg]]\nconst char* s = "x = {};";\n}\n';
    assert.equal(tr({ 'a.cpp': text, 'b.h': 'void __thiscall f(int a, int b);\n' }, 'a.cpp'), text);
  });
});

describe('vc8 translate: __thiscall', () => {
  it('declares a __thiscall free function __fastcall with an unused int', () => {
    assert.equal(one('int __thiscall f(S* p, int a);\n'), 'int __fastcall f(S* p, int, int a);\n');
    assert.equal(one('int __thiscall f(S* p);\n'), 'int __fastcall f(S* p, int);\n');
  });

  it('strips __thiscall from a function without parameters', () => {
    assert.equal(one('int __thiscall f();\n'), 'int f();\n');
  });

  it('casts a call back to the __thiscall type', () => {
    assert.equal(one('int __thiscall f(S* p, int a);\nvoid g(S* s) {\n  f(s, 1);\n}\n'),
      'int __fastcall f(S* p, int, int a);\nvoid g(S* s) {\n  vc8_thiscall(f)(s, 1);\n}\n');
  });

  it('passes the unused int to a function declared static or inline', () => {
    assert.equal(one('static int __thiscall f(S* p, int a);\nvoid g(S* s) {\n  f(s, 1);\n}\n'),
      'static int __fastcall f(S* p, int, int a);\nvoid g(S* s) {\n  f(s, 0, 1);\n}\n');
  });

  it('rewrites __thiscall pointers and the calls through them', () => {
    const files = {
      'a.h': 'struct V {\n  void (__thiscall *pfn)(S* p, int a);\n};\n',
      'a.cpp': 'void g(V* v, S* s) {\n  v->pfn(s, 2);\n}\n',
    };
    assert.equal(tr(files, 'a.h'), 'struct V {\n  void (__fastcall *pfn)(S* p, int, int a);\n};\n');
    assert.equal(tr(files, 'a.cpp'), 'void g(V* v, S* s) {\n  vc8_thiscall(v->pfn)(s, 2);\n}\n');
  });

  it('rewrites an unnamed __thiscall pointer type in a cast', () => {
    assert.equal(one('void* p = (void*)(int (__thiscall *)(S*, int))0;\n'),
      'void* p = (void*)(int (__fastcall *)(S*, int, int))0;\n');
  });

  it('leaves a function stripped that its own qualified name also declares without __thiscall', () => {
    assert.equal(one('int __thiscall f(S* p);\nint f(S* p);\n'), 'int f(S* p);\nint f(S* p);\n');
  });

  it('keys on the qualified name: a same-named function elsewhere does not strip it (Constructor)', () => {
    const files = {
      'stpl.h': 'class HASHKEY_STRI {\npublic:\n    ::HASHKEY_STRI * Constructor(char * szKey);\n};\n',
      'IgnoreList.h': 'namespace D2Common::Chat::Ignorelist::IgnoreList {\n' +
        '::IgnoreList * __thiscall Constructor(::IgnoreList * pThis);\n} // namespace D2Common::Chat::Ignorelist::IgnoreList\n',
      'Ignorelist.cpp': 'namespace D2Common::Chat {\nvoid Init(void* p) {\n' +
        '    gpIgnoreList = p ? Ignorelist::IgnoreList::Constructor(p) : 0;\n}\n} // namespace D2Common::Chat\n',
    };
    assert.equal(tr(files, 'IgnoreList.h'), 'namespace D2Common { namespace Chat { namespace Ignorelist { namespace IgnoreList {\n' +
      '::IgnoreList * __fastcall Constructor(::IgnoreList * pThis, int);\n}}}} // namespace D2Common::Chat::Ignorelist::IgnoreList\n');
    assert.equal(tr(files, 'Ignorelist.cpp'), 'namespace D2Common { namespace Chat {\nvoid Init(void* p) {\n' +
      '    gpIgnoreList = p ? vc8_thiscall(Ignorelist::IgnoreList::Constructor)(p) : 0;\n}\n}} // namespace D2Common::Chat\n');
    // The member function of the same name and arity is a different function: its calls are left alone.
    assert.equal(tr(files, 'stpl.h'), files['stpl.h']);
  });

  it('keys on the qualified name: a same-named __fastcall function in another namespace (Draw)', () => {
    const files = {
      'D2Win.h': 'namespace D2Win::Src::D2WinButton {\nBOOL __fastcall Draw(::D2WinButton * pButton);\n}\n',
      'Button.h': 'namespace D2Client::UI::Button::ButtonWrapper {\nvoid __thiscall Draw(::ButtonWrapper * pThis);\n}\n',
    };
    assert.equal(tr(files, 'Button.h'),
      'namespace D2Client { namespace UI { namespace Button { namespace ButtonWrapper {\nvoid __fastcall Draw(::ButtonWrapper * pThis, int);\n}}}}\n');
  });

  it('resolves an unqualified call from the enclosing namespace outwards', () => {
    const files = {
      'a.h': 'namespace A {\nint __thiscall f(S* p);\nnamespace B {\nint f(S* p);\n}\n}\n',
      'a.cpp': 'namespace A {\nvoid g(S* s) {\n  f(s);\n}\nnamespace B {\nvoid h(S* s) {\n  f(s);\n}\n}\n}\n',
    };
    assert.equal(tr(files, 'a.cpp'),
      'namespace A {\nvoid g(S* s) {\n  vc8_thiscall(f)(s);\n}\nnamespace B {\nvoid h(S* s) {\n  f(s);\n}\n}\n}\n');
  });

  it('ignores declarations VC8 never compiles', () => {
    const text = '#ifndef _WIN32\nint f(S* p);\n#endif\nint __thiscall f(S* p);\n';
    assert.equal(withoutNonWin32(text), '\n\n\nint __thiscall f(S* p);\n');
    assert.equal(one(text), '#ifndef _WIN32\nint f(S* p);\n#endif\nint __fastcall f(S* p, int);\n');
  });
});

describe('vc8 translate: constructors', () => {
  const header = 'struct Pt {\n  Pt(int a, int b) : x(a), y(b) {}\n  Pt() {}\n  int x, y;\n};\n';

  it('blanks the constructors of a struct that is a union member, keeping the lines', () => {
    const files = { 'pt.h': header, 'u.h': 'union U {\n  Pt pt;\n  int n;\n};\n' };
    assert.equal(tr(files, 'pt.h'), 'struct Pt {\n\n\n  int x, y;\n};\n');
  });

  it('turns the braces of a list-initialised struct into constructor calls', () => {
    const files = { 'pt.h': header, 'a.cpp': 'Pt table[] = {{1, 2}, {}};\nPt one = {3, 4};\n' };
    assert.equal(tr(files, 'a.cpp'), 'Pt table[] = {Pt(1, 2), Pt()};\nPt one = Pt(3, 4);\n');
  });
});

describe('vc8 translate: platform header and quarantine', () => {
  it('patches the platform header at anchors that match once', () => {
    const text = '#  include <wintrust.h>\n#define __snprintf snprintf\n#define _snprintf snprintf\n' +
      '#define _vsnprintf vsnprintf\nstatic inline void d2_store24(void* p, uint32_t v) { std::memcpy(p, &v, 3); }\n' +
      '#define __stricmp strcasecmp\n#define _stricmp strcasecmp\n#define _strnicmp strncasecmp\n' +
      ['SmackOpen', 'SmackClose', 'SmackDoFrame', 'SmackNextFrame', 'SmackWait', 'SmackToBuffer', 'BinkOpen',
        'BinkClose', 'BinkDoFrame', 'BinkNextFrame', 'BinkWait', 'BinkCopyToBuffer', 'BinkSetSoundSystem',
        'BinkOpenDirectSound', 'BinkDDSurfaceType', 'ijlInit', 'ijlFree', 'ijlWrite']
        .map(n => `extern "C" void __stdcall ${n}(void* p);\n`).join('');
    const out = applyPatches(PLATFORM_H, text);
    assert.match(out, /^#  include <wintrust.h>\n#  include <vc8_after_windows.h>\n/);
    assert.match(out, /\nextern "C" __declspec\(dllimport\) void __stdcall ijlWrite\(void\* p\);\n$/);
    assert.throws(() => applyPatches(PLATFORM_H, '#define __snprintf snprintf\n'), /matches 0 times/);
  });

  it('blanks the body of a quarantined function, keeping its lines', () => {
    const text = 'int f(int a) {\n  return a;\n}\nint g() {\n  if (1) {\n    return 2;\n  }\n}\n';
    assert.equal(tr({ 'a.cpp': text }, 'a.cpp', [6]),
      'int f(int a) {\n  return a;\n}\nint g() { __assume(0);\n\n\n\n}\n');
    assert.deepEqual(functionAt(text, 6), { line: 4, name: 'g' });
    assert.equal(functionAt(text, 9), null);
  });

  it('never changes the line count', () => {
    const text = 'namespace A::B {\nstruct __attribute__((packed)) S {\n  S() = default;\n  char c;\n};\n' +
      'int __thiscall f(S* p, int a);\nvoid g(S* s) { f(s, 0b1); }\n} // namespace A::B\n';
    const out = one(text, 'a.h');
    assert.equal(out.split('\n').length, text.split('\n').length);
  });
});

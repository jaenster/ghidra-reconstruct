/**
 * Template declarations: Storm's `stpl.h` as real C++ templates.
 *
 * The generator will emit class templates, members defined out of class and `template<>`
 * explicit member specializations, and the defect lint parses every file it emits. Before
 * this the parser had no rule for the `template` keyword at all, and a class could not be
 * named by a template-id, so each of these cost the lint a whole declaration.
 *
 * Every case is checked three ways: the AST holds what was written, the emitter prints it
 * back, and a second parse of that print gives the same print.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { emit } from '../../emit/index.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';
import { compileAndRun, hasNativeGpp } from '../../testing/native-cpp.js';
import type { AnyNode } from '../../ast/nodes.js';

const flat = (s: string) => s.replace(/\s+/g, ' ').trim();

/** Emit, re-parse, emit again; the two prints must agree. */
function roundTrip(src: string): string {
  const once = emit(parse(src) as AnyNode);
  const twice = emit(parse(once) as AnyNode);
  assert.strictEqual(twice, once, `not stable under a second parse:\n${once}`);
  return flat(once);
}

describe('template-ids that already parsed keep parsing (the S0 probes)', () => {
  const probes: Array<[string, string]> = [
    ['void f(){ x = TSHashTable<CELLIST,HASHKEY_NONE>::Ptr((TSHashTable<CELLIST,HASHKEY_NONE> *)&g, 1, &k); }',
      'void f() { x = TSHashTable<CELLIST, HASHKEY_NONE>::Ptr((TSHashTable<CELLIST, HASHKEY_NONE>*)&g, 1, &k); }'],
    ['void f(){ TSExplicitList<SGAMEDATA,-572662307>::UnlinkAll((D2TSExplicitListHeadStrc *)p); }',
      'void f() { TSExplicitList<SGAMEDATA, -572662307>::UnlinkAll((D2TSExplicitListHeadStrc*)p); }'],
    ['void f(){ TSGrowableArray<TSExplicitList<SGAMEDATA,-572662307>>::CalcChunkSize(this,n); }',
      'void f() { TSGrowableArray<TSExplicitList<SGAMEDATA, -572662307>>::CalcChunkSize(this, n); }'],
    ['void f(){ TSExportTableSync<SGAMEDATA,HSGAMEDATA__*,HSGAMEDATALOCK__*,CCritSect,0>::Lock(p,1,q,0); }',
      'void f() { TSExportTableSync<SGAMEDATA, HSGAMEDATA__*, HSGAMEDATALOCK__*, CCritSect, 0>::Lock(p, 1, q, 0); }'],
    ['void f(){ p->super_TSHashTable<CELLIST,HASHKEY_NONE>.nSlotMask = 0; }',
      'void f() { p->super_TSHashTable<CELLIST, HASHKEY_NONE>.nSlotMask = 0; }'],
    ['void f(){ a = p->member.x < 3 && b > 2; }', 'void f() { a = p->member.x < 3 && b > 2; }'],
    ['void f(){ g.Ptr(1); p->tFull.UnlinkAll(); }', 'void f() { g.Ptr(1); p->tFull.UnlinkAll(); }'],
  ];
  for (const [src, want] of probes) {
    it(want.slice(11, 70), () => assert.strictEqual(roundTrip(src), want));
  }

  it('a negative literal argument is still one unary expression', () => {
    const tt: any = findNodesByKind(parse('void f(){ TSExplicitList<SGAMEDATA,-572662307>::UnlinkAll(p); }'), NodeKind.TemplateType)[0];
    assert.strictEqual(tt.arguments[1].kind, NodeKind.ExprTemplateArg);
    assert.strictEqual(tt.arguments[1].expression.kind, NodeKind.UnaryExpr);
    assert.strictEqual(tt.arguments[1].expression.operand.kind, NodeKind.IntegerLiteral);
  });
});

describe('the two forms that failed with "Expected Identifier, got template"', () => {
  it('a class template definition', () => {
    const src = 'template<class T,int N> struct TSExplicitList { int nLinkOffset; };';
    assert.strictEqual(roundTrip(src), 'template<class T, int N> struct TSExplicitList { int nLinkOffset; };');
    const td: any = parse(src).declarations[0];
    assert.strictEqual(td.kind, NodeKind.TemplateDecl);
    assert.deepStrictEqual(td.parameters.map((p: any) => [p.kind, p.name.name]),
      [[NodeKind.TemplateTypeParam, 'T'], [NodeKind.TemplateNonTypeParam, 'N']]);
    assert.strictEqual(td.parameters[0].keyword, 'class');
    assert.strictEqual(td.declaration.kind, NodeKind.StructDecl);
  });

  it('an explicit member specialization, `template<>`', () => {
    const src = 'template<> CELLIST * TSHashTable<CELLIST,HASHKEY_NONE>::Ptr(uint32_t h) { return 0; }';
    assert.strictEqual(roundTrip(src), 'template<> CELLIST* TSHashTable<CELLIST, HASHKEY_NONE>::Ptr(uint32_t h) { return 0; }');
    const td: any = parse(src).declarations[0];
    assert.deepStrictEqual(td.parameters, []);
    assert.strictEqual(td.declaration.kind, NodeKind.FunctionDecl);
    assert.strictEqual(td.declaration.name.qualifier[0].kind, NodeKind.TemplateType);
    assert.ok(td.declaration.body);
  });
});

describe('class templates', () => {
  it('a forward declaration stays a declaration, not an empty definition', () => {
    assert.strictEqual(roundTrip('template<class T> class TSLink;'), 'template<class T> class TSLink;');
    assert.strictEqual(roundTrip('namespace N { struct S; }'), 'namespace N { struct S; }');
    const s: any = parse('struct S;').declarations[0];
    assert.strictEqual(s.isForwardDeclaration, true);
  });

  it('access specifiers, a base class and a static member taking pThis', () => {
    const src = 'template<class T, class TKey, int N> class TSHashTableReuse : public TSHashTable<T, TKey> {\n' +
      'public:\n  TSExplicitList<T, -572662307> m_reuselist;\n  static T* New(TSHashTableReuse* pThis);\n};';
    assert.strictEqual(roundTrip(src), flat(src));
    const cls: any = (parse(src).declarations[0] as any).declaration;
    assert.strictEqual(cls.kind, NodeKind.ClassDecl);
    assert.strictEqual(cls.bases.length, 1);
    assert.strictEqual(cls.bases[0].access, 'public');
    // A template-id type is a TypedefType named by a TemplateType, as everywhere else.
    assert.strictEqual(cls.bases[0].type.name.kind, NodeKind.TemplateType);
    assert.strictEqual(cls.members[0].kind, NodeKind.AccessSpecifier);
  });

  it('several bases, virtual on either side of the access, a pack expansion', () => {
    const src = 'template<class... Ts> struct X : virtual private A, public virtual B<int>, Ts... { };';
    assert.strictEqual(roundTrip(src), 'template<class... Ts> struct X : virtual private A, virtual public B<int>, Ts... { };');
    const cls: any = (parse(src).declarations[0] as any).declaration;
    assert.deepStrictEqual(cls.bases.map((b: any) => [b.access, b.isVirtual, b.isPackExpansion]),
      [['private', true, false], ['public', true, false], [null, false, true]]);
  });

  it('a class specialization is named by its template-id, and its constructor by the template name', () => {
    assert.strictEqual(roundTrip('template<> struct d2_bits_word<true> { typedef uint64_t type; };'),
      'template<> struct d2_bits_word<true> { typedef uint64_t type; };');
    const s: any = (parse('template<> struct d2_bits_word<true> { d2_bits_word(); };').declarations[0] as any).declaration;
    assert.strictEqual(s.name.kind, NodeKind.TemplateType);
    assert.strictEqual(s.name.name.name, 'd2_bits_word');
    assert.strictEqual(s.name.arguments[0].expression.kind, NodeKind.BoolLiteral);
    assert.strictEqual(s.members[0].kind, NodeKind.FunctionDecl);
    assert.strictEqual(s.members[0].name.name, 'd2_bits_word');
  });

  it('a partial specialization', () => {
    assert.strictEqual(roundTrip('template<class T> struct S<T*, 0> : S<T, 0> { };'),
      'template<class T> struct S<T*, 0> : S<T, 0> { };');
  });
});

describe('template parameters', () => {
  it('class and typename keep their keyword; defaults of each kind', () => {
    const src = 'template<class T, typename U = int, int N = -0x22222223, template<class> class TT = TSList> struct L { };';
    assert.strictEqual(roundTrip(src), flat(src));
    const ps: any[] = (parse(src).declarations[0] as any).parameters;
    assert.deepStrictEqual(ps.map(p => p.keyword ?? null), ['class', 'typename', null, 'class']);
    assert.strictEqual(ps[1].defaultType.kind, NodeKind.BuiltinType);
    assert.strictEqual(ps[2].defaultValue.kind, NodeKind.UnaryExpr);
    assert.strictEqual(ps[3].defaultTemplate.name, 'TSList');
  });

  it('a `>` inside a value is the list\'s end unless bracketed, and the emitter keeps the brackets', () => {
    const src = 'template<int M = (1 > 0), int K = (2 >> 1), int J = sizeof(L<1>)> struct L { };';
    assert.strictEqual(roundTrip(src), 'template<int M = (1 > 0), int K = (2 >> 1), int J = sizeof(L<1>)> struct L { };');
    const ps: any[] = (parse(src).declarations[0] as any).parameters;
    assert.strictEqual(ps[0].defaultValue.expression.operator, '>');
    assert.strictEqual(ps.length, 3);
  });

  it('a value parameter of an elaborated type is not a type parameter', () => {
    const p: any = (parse('template<class C* p> struct L { };').declarations[0] as any).parameters[0];
    assert.strictEqual(p.kind, NodeKind.TemplateNonTypeParam);
    assert.strictEqual(p.type.kind, NodeKind.PointerType);
  });

  it('value arguments: bool, parenthesised comparison, an expression ending at `>>`', () => {
    assert.strictEqual(roundTrip('d2_bits_word<(sizeof(T) > sizeof(uintptr_t))> x;'),
      'd2_bits_word<(sizeof(T) > sizeof(uintptr_t))> x;');
    assert.strictEqual(roundTrip('A<B<1 + 2>> y;'), 'A<B<1 + 2>> y;');
  });
});

describe('members defined out of class, and nested templates', () => {
  it('a generic member and a member template of a class template', () => {
    assert.strictEqual(roundTrip('template<class T, class K> T* TSHashTable<T, K>::Ptr(uint32_t h) { return 0; }'),
      'template<class T, class K> T* TSHashTable<T, K>::Ptr(uint32_t h) { return 0; }');
    assert.strictEqual(roundTrip('template<class T> struct O { template<class U> U Get(T t); };'),
      'template<class T> struct O { template<class U> U Get(T t); };');
    const src = 'template<class T> template<class U> U O<T>::Get(T t) { return 0; }';
    assert.strictEqual(roundTrip(src), src);
    const inner: any = (parse(src).declarations[0] as any).declaration;
    assert.strictEqual(inner.kind, NodeKind.TemplateDecl);
    assert.strictEqual(inner.declaration.kind, NodeKind.FunctionDecl);
  });

  it('an alias template and a template inside a namespace', () => {
    assert.strictEqual(roundTrip('template<class T> using Ptr = T*;'), 'template<class T> using Ptr = T*;');
    assert.strictEqual(roundTrip('namespace N { template<class T> struct S; }'), 'namespace N { template<class T> struct S; }');
  });

  it('in recovery mode a template it cannot read costs that one declaration, not its neighbours', () => {
    // A dependent `typename T::type` is not read yet.
    const tu: any = parse('template<class T> T f(T t) { return t; }\ntemplate<class T> typename T::type g();\nint h() { return 1; }',
      { recover: true });
    assert.deepStrictEqual(tu.parseErrors.map((e: any) => e.location.start.line), [2]);
    assert.deepStrictEqual(findNodesByKind(tu, NodeKind.FunctionDecl).map((f: any) => f.name.name), ['f', 'h']);
  });
});

describe('the visitor reaches into template headers and class heads', () => {
  it('base-class types and parameter defaults are children', () => {
    const tu = parse('template<class T, int N = 4, class K = HASHKEY_NONE> class R : public TSHashTable<T, K> { };');
    const names = findNodesByKind(tu, NodeKind.TypedefType)
      .map((t: any) => t.name.kind === NodeKind.TemplateType ? t.name.name.name : t.name.name).sort();
    // The base's template-id holds its argument types as children too.
    assert.deepStrictEqual(names, ['HASHKEY_NONE', 'K', 'T', 'TSHashTable']);
    assert.strictEqual(findNodesByKind(tu, NodeKind.IntegerLiteral).length, 1);
  });
});

describe('the emitted templates are C++ a compiler accepts', () => {
  it('compiles a stpl.h-shaped header: primaries, a derived template, a member specialization, a generic member', { skip: !hasNativeGpp() }, () => {
    const src = `
template<class T> class TSLink;
template<class T> class TSLink { public: TSLink<T>* m_prevlink; int m_next; };
template<class T, int OFFSET> class TSExplicitList { public: int m_linkoffset; TSLink<T> m_terminator; static T* Head(TSExplicitList* pThis); };
struct HASHKEY_NONE { };
template<class T, class TKey> class TSHashTable {
public:
  TSExplicitList<T, -572662307> m_fulllist;
  static T* Ptr(TSHashTable* pThis, unsigned h, TKey* k);
  static unsigned Mask(TSHashTable* pThis);
};
template<class T, class TKey, int N> class TSHashTableReuse : public TSHashTable<T, TKey> { public: unsigned m_chunksize; };
struct CELLIST { int x; };
template<> CELLIST* TSHashTable<CELLIST, HASHKEY_NONE>::Ptr(TSHashTable<CELLIST, HASHKEY_NONE>* pThis, unsigned h, HASHKEY_NONE* k) { return 0; }
template<class T, class TKey> unsigned TSHashTable<T, TKey>::Mask(TSHashTable* pThis) { return sizeof(T); }
template<bool bWide> struct W { typedef unsigned type; };
template<> struct W<true> { typedef unsigned long long type; };
static_assert(sizeof(TSHashTableReuse<CELLIST, HASHKEY_NONE, 0>) > sizeof(TSHashTable<CELLIST, HASHKEY_NONE>), "base then member");
static_assert(sizeof(W<(sizeof(long long) > 4)>::type) == 8, "specialization chosen");
unsigned use() { return TSHashTable<CELLIST, HASHKEY_NONE>::Mask(0); }
`;
    const emitted = emit(parse(src) as AnyNode);
    assert.strictEqual(compileAndRun(emitted, 'printf("%u\\n", use());').trim(), '4');
  });
});

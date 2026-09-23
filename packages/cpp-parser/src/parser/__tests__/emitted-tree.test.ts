/**
 * The parser must read the tree the generator WRITES, not only the pseudo-C Ghidra hands it:
 * the defect lint parses every emitted .cpp and .h, and a construct it cannot read is a
 * function the lint never checks. Each case here is a shape that stopped a whole file from
 * parsing before (nested namespaces alone failed ~1000 of 1082 files).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../index.js';
import { NodeKind } from '../../ast/kinds.js';
import { findNodesByKind } from '../../ast/visitor.js';

const fns = (src: string) =>
  (findNodesByKind(parse(src, { recover: true }), NodeKind.FunctionDecl) as any[]).filter(f => f.body);

describe('emitted-tree constructs', () => {
  it('reads a C++17 nested namespace as nested NamespaceDecls, and the visitor descends into it', () => {
    const tu: any = parse('namespace A::B::C { int f() { return 1; } }');
    assert.strictEqual(tu.declarations[0].kind, NodeKind.NamespaceDecl);
    assert.strictEqual(tu.declarations[0].name.name, 'A');
    assert.strictEqual(tu.declarations[0].declarations[0].declarations[0].name.name, 'C');
    assert.strictEqual(fns('namespace A::B::C { int f() { return 1; } }').length, 1);
  });

  it('reads static_assert at block scope and a frame-group struct under an indented #pragma', () => {
    const src = `void f() {
    #pragma pack(push, 1)
    struct __frame0_t { uint8_t a; uint32_t b; };
    #pragma pack(pop)
    static_assert(sizeof(void*) != 4 || sizeof(__frame0_t) == 5, "frame group");
    __frame0_t __frame0;
}`;
    const tu = parse(src);
    assert.strictEqual(findNodesByKind(tu, NodeKind.StaticAssertDecl).length, 1);
    const s: any = findNodesByKind(tu, NodeKind.StructDecl)[0];
    assert.ok(s.leadingTrivia.some((t: any) => /pragma pack\(push, 1\)/.test(t.text)));
  });

  it('reads extern "C" on a definition and a calling convention before the type', () => {
    assert.strictEqual(fns('extern "C" int32_t __stdcall WinMain(HINSTANCE h, int n) { return 0; }').length, 1);
    const tu: any = parse('extern "C" __stdcall void* SmackOpen(const char* s, uint32_t f);');
    assert.strictEqual(tu.declarations[0].kind, NodeKind.LinkageSpec);
  });

  it('reads pointer-to-function declarators: typedef, local, parameter, abstract cast', () => {
    const tu: any = parse(`typedef int (__stdcall *pfnX)(LPCSTR a, DWORD * b);
void f(void (*cb)(int)) {
    int (*pfn)(int, char*) = 0;
    ((void (__attribute__((fastcall)) *)(D2ClientStrc*, void*))fp)(a, b);
    (*(void (**)(int*))((char*)p + 44))((int*)q);
    x = (code*)(LONG (__cdecl *)(LONG volatile*, LONG, LONG))InterlockedCompareExchange;
}`);
    const td = tu.declarations[0];
    assert.strictEqual(td.name.name, 'pfnX');
    assert.strictEqual(td.type.kind, NodeKind.PointerType);
    assert.strictEqual(td.type.pointee.kind, NodeKind.FunctionType);
    assert.strictEqual(td.type.pointee.callingConvention, '__stdcall');
    const fn = tu.declarations[1];
    assert.strictEqual(fn.parameters[0].name.name, 'cb');
    assert.strictEqual(findNodesByKind(fn, NodeKind.CallExpr).length, 2);
  });

  it('reads a cast to a globally-qualified type and sizeof of an expression', () => {
    const tu = parse('void f() { p = (::BnMessQueue*)q; n = sizeof(pThis->a[0]); }');
    const casts: any[] = findNodesByKind(tu, NodeKind.CStyleCastExpr);
    assert.strictEqual(casts.length, 1);
    const so: any = findNodesByKind(tu, NodeKind.SizeofExpr)[0];
    assert.strictEqual(so.isType, false);
    assert.strictEqual(so.operand.kind, NodeKind.SubscriptExpr);
  });

  it('reads direct-initialisation, several declarators, bit-fields and an unnamed bit-field', () => {
    const tu: any = parse(`struct S { uint8_t a : 1; uint8_t : 3; uint8_t restrict : 1; };
void f() { D2GSPacketClt0x6B packet(0x6b); int x, *y, z[4]; }`);
    const s = tu.declarations[0];
    assert.strictEqual(s.members.length, 3);
    assert.ok(s.members[0].bitWidth);
    assert.strictEqual(s.members[2].name.name, 'restrict');
    const decls: any[] = findNodesByKind(tu.declarations[1], NodeKind.VariableDecl);
    assert.deepStrictEqual(decls.map(d => d.name.name), ['packet', 'x', 'y', 'z']);
    assert.strictEqual(decls[0].directInit, true);
    assert.strictEqual(decls[2].type.kind, NodeKind.PointerType);
    assert.strictEqual(decls[3].type.kind, NodeKind.ArrayType);
  });

  it('reads using-declarations, attributes on a struct, constructors and conversion operators', () => {
    const tu: any = parse(`using D2AITypes_ns::AI_DEFAULT;
using namespace std;
using U8 = unsigned char;
struct __attribute__((packed)) P { uint8_t a; uint32_t b; };
struct E { E() = default; E(uint32_t v) : r(v) {} operator uint32_t() const { return r; } uint32_t r; };`);
    assert.deepStrictEqual(tu.declarations.slice(0, 3).map((d: any) => d.kind),
      [NodeKind.UsingDecl, NodeKind.UsingDirective, NodeKind.TypeAliasDecl]);
    assert.strictEqual(tu.declarations[3].packed, true);
    assert.strictEqual(tu.declarations[4].members.length, 4);
  });

  it('reads named casts, throw and adjacent string literals', () => {
    const tu = parse('void f() { *reinterpret_cast<uint32_t*>(this) = v; throw; s = "a" "b"; }');
    assert.strictEqual(findNodesByKind(tu, NodeKind.ReinterpretCastExpr).length, 1);
    const lit: any = findNodesByKind(tu, NodeKind.StringLiteral)[0];
    assert.strictEqual(lit.value, 'ab');
  });

  it('does not take a comparison for template arguments inside a cast', () => {
    const tu = parse('int f() { return (uint32_t)(nY < p->W.y + nPosY); }');
    assert.strictEqual(findNodesByKind(tu, NodeKind.CStyleCastExpr).length, 1);
    const tu2 = parse('int f() { if ((int)((int)n * 2 - ((int)n < 5 ? 0 : 9)) <= (int)(m * 2 - (m < 5 ? 0 : 9))) return 1; return 0; }');
    assert.strictEqual(findNodesByKind(tu2, NodeKind.ConditionalExpr).length, 2);
  });

  it('recovers past a declaration it cannot read, and records it', () => {
    const src = `namespace N {
int good1() { return 1; }
MACRO_WEAK void bad() {}
int good2() { return 2; }
}`;
    assert.throws(() => parse(src));
    const tu: any = parse(src, { recover: true });
    assert.strictEqual(tu.parseErrors.length, 1);
    assert.strictEqual(tu.parseErrors[0].location.start.line, 3);
    assert.deepStrictEqual(fns(src).map((f: any) => f.name.name), ['good1', 'good2']);
  });
});

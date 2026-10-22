/**
 * Class template-ids in decompiled bodies: what the lexer, the visitor, the
 * emitter, the Ghidra preprocessor and the cast passes' type environment have to
 * get right once `TSHashTable<CELLIST, HASHKEY_NONE>` is a real type in a body
 * rather than a flattened identifier.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { NodeKind } from '../ast/kinds.js';
import { getChildren, transformAST } from '../ast/visitor.js';
import { Lexer } from '../lexer/lexer.js';
import { TokenKind } from '../lexer/token.js';
import { parse } from '../parser/index.js';
import { emit } from '../emit/index.js';
import { preprocessGhidraCode } from '../ghidra.js';
import { shapeOfSpelling, typeFromSpelling } from '../transform/plugins/builtins/call-arg-cast.js';

function typeOf(spelling: string): any {
  return (parse(`typedef ${spelling} t;`) as any).declarations[0].type;
}

function kinds(src: string): TokenKind[] {
  return new Lexer(src, { preserveTrivia: false }).tokenize().map(t => t.kind);
}

describe('template-ids in bodies', () => {
  it('lexes `<::` as `<` then `::` when no `:` or `>` follows', () => {
    assert.deepStrictEqual(kinds('A<::B>').slice(0, 4), [TokenKind.Identifier, TokenKind.Less, TokenKind.ColonColon, TokenKind.Identifier]);
    // The digraph still stands where the exception does not apply.
    assert.strictEqual(kinds('a<:0:>')[1], TokenKind.DiLeftBracket);
    assert.strictEqual(emit(typeOf('TSHashTable<::CELLIST, HASHKEY_NONE>*')), 'TSHashTable<::CELLIST, HASHKEY_NONE>*');
  });

  it('visits the argument types of a template-id, and of the class qualifying a member type', () => {
    const names = (spelling: string) => {
      const out: string[] = [];
      const stack: any[] = [typeOf(spelling)];
      while (stack.length) {
        const n = stack.pop();
        if (n.kind === NodeKind.Identifier) out.push(n.name);
        // A plain type name is a leaf: its identifier is the node's own name.
        if (n.kind === NodeKind.TypedefType && n.name.kind === NodeKind.Identifier) out.push(`type ${n.name.name}`);
        stack.push(...getChildren(n));
      }
      return out.sort();
    };
    assert.deepStrictEqual(names('TSList<TCELENTRY, TSGetLink<TCELENTRY>>*'), ['TSGetLink', 'TSList', 'type TCELENTRY', 'type TCELENTRY']);
    assert.deepStrictEqual(names('TSHashTable<CELLIST, HASHKEY_NONE>::Vtable*'), ['TSHashTable', 'Vtable', 'type CELLIST', 'type HASHKEY_NONE']);
    // A plain type name is still a leaf.
    assert.deepStrictEqual(getChildren(typeOf('CELLIST')), []);
  });

  it('lets a transform rewrite a template argument type', () => {
    const renamed = transformAST(typeOf('TSHashTable<CELLIST, HASHKEY_NONE>*'), {
      visitNode(n: any) {
        if (n.kind === NodeKind.TypedefType && n.name.kind === NodeKind.Identifier && n.name.name === 'CELLIST') {
          return { ...n, name: { ...n.name, name: 'SGAMEDATA' } };
        }
        return undefined;
      },
    });
    assert.strictEqual(emit(renamed), 'TSHashTable<SGAMEDATA, HASHKEY_NONE>*');
  });

  it('keeps the parentheses of a `<` comparison on the left of `>`', () => {
    const tu: any = parse('void f() { r = (y < z) > w; s = (a < b) >= c; t = (a < b) < c; }');
    const out = emit(tu);
    assert.match(out, /r = \(y < z\) > w;/);
    assert.match(out, /s = \(a < b\) >= c;/);
    // Nothing a template argument list could swallow: no parentheses added.
    assert.match(out, /t = a < b < c;/);
  });

  it('renames a `this` declarator whose type is a template-id', () => {
    const out = preprocessGhidraCode('{\n  TSExportTableSync<SGAMEDATA,HSGAMEDATA__*,HSGAMEDATALOCK__*,CCritSect,0> *this;\n  this = gp;\n}');
    assert.match(out, /CCritSect,0> \*self;/);
  });

  it('parses a member named in a base class, through a template-id', () => {
    const tu: any = parse('void f() { g.TSHashTable<::CELLIST, HASHKEY_NONE>::Ptr(h, &g.m_key); p->A::B::f(); q->X<1>::~X(); s.N::Y<int>::g(); r = c ? a.b : d; }');
    const calls = tu.declarations[0].body.statements.slice(0, 4).map((st: any) => st.expression.callee);
    for (const m of calls) {
      assert.strictEqual(m.kind, NodeKind.MemberExpr);
      assert.strictEqual(m.member.kind, NodeKind.QualifiedId);
    }
    assert.strictEqual(calls[0].member.qualifier[0].kind, NodeKind.TemplateType);
    assert.strictEqual(calls[0].member.name.name, 'Ptr');
    assert.deepStrictEqual(calls[1].member.qualifier.map((q: any) => q.name), ['A', 'B']);
    assert.strictEqual(calls[3].member.qualifier[1].kind, NodeKind.TemplateType);
    const out = emit(tu);
    assert.match(out, /g\.TSHashTable<::CELLIST, HASHKEY_NONE>::Ptr\(h, &g\.m_key\);/);
    assert.match(out, /p->A::B::f\(\);/);
    assert.match(out, /q->X<1>::~X\(\);/);
    assert.match(out, /s\.N::Y<int>::g\(\);/);
    assert.match(out, /r = c \? a\.b : d;/);
  });

  it('reads a template-id as a type base in the cast passes, root qualifiers aside', () => {
    assert.deepStrictEqual(shapeOfSpelling('TSExplicitList<CELLIST, -572662307> *'),
      { base: 'TSExplicitList<CELLIST, -572662307>', stars: 1, isConst: false });
    assert.deepStrictEqual(shapeOfSpelling('TSExplicitList<::CELLIST, -572662307>*'),
      shapeOfSpelling('TSExplicitList<CELLIST, -572662307> *'));
    assert.deepStrictEqual(shapeOfSpelling('TSHashTable<CELLIST, HASHKEY_NONE>::Vtable *'),
      { base: 'TSHashTable<CELLIST, HASHKEY_NONE>::Vtable', stars: 1, isConst: false });
    const cast = typeFromSpelling('TSExportTableSync<SGAMEDATA, HSGAMEDATA__*, HSGAMEDATALOCK__*, CCritSect, 0> *');
    assert.ok(cast);
    assert.strictEqual(emit(cast as any), 'TSExportTableSync<SGAMEDATA, HSGAMEDATA__*, HSGAMEDATALOCK__*, CCritSect, 0>*');
    // A comparison is still no type.
    assert.strictEqual(typeFromSpelling('a < b'), null);
  });
});

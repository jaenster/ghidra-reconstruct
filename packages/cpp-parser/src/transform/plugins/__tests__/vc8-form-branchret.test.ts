import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, FunctionDecl, IfStmt, TranslationUnit, VariableDecl } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite, type Vc8FormTables } from '../builtins/vc8-form.js';

const base = `int32_t GetNextPositon(D2BitBufferStrc *pBitBuffer) {
  size_t nNextPos = pBitBuffer->nCurrentPos;
  if (!pBitBuffer->nBitsAtPos) { return nNextPos; }
  nNextPos++;
  return nNextPos;
}`;

const fields: Vc8FormTables = { structFields: { D2BitBufferStrc: { nCurrentPos: 'size_t', nBitsAtPos: 'size_t' } } };
function run(source: string, tag = 'branchret(nNextPos)', tables: Vc8FormTables = fields) {
  const sites: Vc8FormSite[] = [];
  const form = parseVc8Form(tag);
  assert.ok(form);
  const parsed = parse(source) as TranslationUnit;
  const before = emit(parsed as AnyNode);
  const after = emit(applyVc8Forms(parsed, [{ form, tag }], site => sites.push(site), tables) as AnyNode);
  assert.equal(sites.length, 1);
  return { before, after, site: sites[0]! };
}

describe('vc8-form branchret', () => {
  it('rewrites the measured unsigned bit-position return', () => {
    const { after, site } = run(base);
    assert.equal(site.applied, true, site.why);
    assert.match(after, /if \(pBitBuffer->nBitsAtPos\) \{\s*return \(size_t\)\(\(size_t\)pBitBuffer->nCurrentPos \+ 1\);/);
    assert.match(after, /return \(size_t\)pBitBuffer->nCurrentPos;/);
    assert.doesNotMatch(after, /nNextPos/);
  });

  it('refuses changed types, fields, pointer, guard, store, or effects', () => {
    const variants = [
      base.replace('size_t nNextPos', 'int32_t nNextPos'),
      base.replace('int32_t GetNextPositon', 'float GetNextPositon'),
      base.replace('D2BitBufferStrc *pBitBuffer', 'volatile D2BitBufferStrc *pBitBuffer'),
      base.replace('nCurrentPos', 'nOtherPos'),
      base.replace('nBitsAtPos', 'nOtherBits'),
      base.replace('if (!pBitBuffer->nBitsAtPos)', 'if constexpr (!pBitBuffer->nBitsAtPos)'),
      base.replace('nNextPos++;', 'nNextPos += 2;'),
      base.replace('nNextPos++;', 'Touch(); nNextPos++;'),
      base.replace('size_t nNextPos = pBitBuffer->nCurrentPos;', 'size_t nNextPos(pBitBuffer->nCurrentPos);'),
      base.replace('return nNextPos;\n}', 'Observe(nNextPos); return nNextPos;\n}'),
      base.replace('return nNextPos; }', 'return 0; }'),
      base.replace('return nNextPos;\n}', 'return 0;\n}'),
    ];
    for (const source of variants) {
      const { before, after, site } = run(source);
      assert.equal(site.applied, false, source);
      assert.equal(after, before, source);
    }
    const wrongName = run(base, 'branchret(other)');
    assert.equal(wrongName.site.applied, false);
    assert.equal(wrongName.after, wrongName.before);
  });

  it('refuses hidden if initializers and declaration attributes', () => {
    // The parser currently rejects C++17 if-init syntax, but an AST supplied
    // by another pass can still carry it. A rewrite must not drop its effect.
    const form = parseVc8Form('branchret(nNextPos)')!;
    const init = parse('void h() { Touch(); }').declarations[0] as FunctionDecl;
    const withIfInit = parse(base) as TranslationUnit;
    const fn = withIfInit.declarations[0] as FunctionDecl;
    (fn.body!.statements[1] as IfStmt).init = init.body!.statements[0];
    const sites: Vc8FormSite[] = [];
    applyVc8Forms(withIfInit, [{ form }], site => sites.push(site), fields);
    assert.equal(sites[0]?.applied, false);

    const withAttribute = parse(base) as TranslationUnit;
    const attrFn = withAttribute.declarations[0] as FunctionDecl;
    const decl = (attrFn.body!.statements[0] as unknown as { declarations: VariableDecl[] }).declarations[0]!;
    decl.attributes.push({ kind: 'Attribute', name: 'maybe_unused' } as never);
    const attrSites: Vc8FormSite[] = [];
    applyVc8Forms(withAttribute, [{ form }], site => attrSites.push(site), fields);
    assert.equal(attrSites[0]?.applied, false);
  });
  it('derives different struct, local, and field names from a positive increment arm', () => {
    const source = 'uint32_t Next(Reader* r) { uint32_t count = r->position; if (r->pending != 0) { count += 1; } return count; }';
    const result = run(source, 'branchret(count)', { structFields: { Reader: { position: 'uint32_t', pending: 'uint8_t' } } });
    assert.equal(result.site.applied, true, result.site.why);
    assert.match(result.after, /if \(r->pending\)/);
    assert.match(result.after, /return \(uint32_t\)\(\(uint32_t\)r->position \+ 1\);/);
  });

  it('preserves a narrow local conversion before a wider function return', () => {
    const source = 'uint32_t Next(Tiny* p) { uint8_t v = p->value; if (p->flag) ++v; return v; }';
    const result = run(source, 'branchret(v)', { structFields: { Tiny: { value: 'uint8_t', flag: 'bool' } } });
    assert.equal(result.site.applied, true, result.site.why);
    assert.match(result.after, /return \(uint8_t\)\(\(uint8_t\)p->value \+ 1\);/);
  });

  it('requires exact field facts and rejects volatile or differently signed loads', () => {
    for (const tables of [
      {},
      { fieldTypes: { nCurrentPos: 'size_t', nBitsAtPos: 'size_t' } },
      { structFields: { D2BitBufferStrc: { nCurrentPos: 'int32_t', nBitsAtPos: 'size_t' } } },
      { structFields: { D2BitBufferStrc: { nCurrentPos: 'volatile size_t', nBitsAtPos: 'size_t' } } },
      { structFields: { D2BitBufferStrc: { nCurrentPos: 'size_t', nBitsAtPos: 'volatile size_t' } } },
      { ...fields, typedefTargets: { Alias: 'volatile D2BitBufferStrc' } },
    ] as Vc8FormTables[]) {
      const source = tables.typedefTargets ? base.replace('D2BitBufferStrc *', 'Alias *') : base;
      const result = run(source, 'branchret(nNextPos)', tables);
      assert.equal(result.site.applied, false);
      assert.equal(result.after, result.before);
    }
  });
});

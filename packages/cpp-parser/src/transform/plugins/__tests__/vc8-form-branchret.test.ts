import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode, FunctionDecl, IfStmt, TranslationUnit, VariableDecl } from '../../../ast/nodes.js';
import { applyVc8Forms, parseVc8Form, type Vc8FormSite } from '../builtins/vc8-form.js';

const base = `int32_t GetNextPositon(D2BitBufferStrc *pBitBuffer) {
  size_t nNextPos = pBitBuffer->nCurrentPos;
  if (!pBitBuffer->nBitsAtPos) { return nNextPos; }
  nNextPos++;
  return nNextPos;
}`;

function run(source: string, tag = 'branchret(nNextPos)') {
  const sites: Vc8FormSite[] = [];
  const form = parseVc8Form(tag);
  assert.ok(form);
  const parsed = parse(source) as TranslationUnit;
  const before = emit(parsed as AnyNode);
  const after = emit(applyVc8Forms(parsed, [{ form, tag }], site => sites.push(site)) as AnyNode);
  assert.equal(sites.length, 1);
  return { before, after, site: sites[0]! };
}

describe('vc8-form branchret', () => {
  it('rewrites the measured unsigned bit-position return', () => {
    const { after, site } = run(base);
    assert.equal(site.applied, true, site.why);
    assert.match(after, /if \(pBitBuffer->nBitsAtPos\) \{\s*return pBitBuffer->nCurrentPos \+ 1;/);
    assert.match(after, /return pBitBuffer->nCurrentPos;/);
    assert.doesNotMatch(after, /nNextPos/);
  });

  it('refuses changed types, fields, pointer, guard, store, or effects', () => {
    const variants = [
      base.replace('size_t nNextPos', 'int32_t nNextPos'),
      base.replace('int32_t GetNextPositon', 'uint32_t GetNextPositon'),
      base.replace('D2BitBufferStrc *pBitBuffer', 'volatile D2BitBufferStrc *pBitBuffer'),
      base.replace('nCurrentPos', 'nOtherPos'),
      base.replace('nBitsAtPos', 'nOtherBits'),
      base.replace('if (!pBitBuffer->nBitsAtPos)', 'if (pBitBuffer->nBitsAtPos)'),
      base.replace('if (!pBitBuffer->nBitsAtPos)', 'if constexpr (!pBitBuffer->nBitsAtPos)'),
      base.replace('nNextPos++;', 'nNextPos += 1;'),
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
    applyVc8Forms(withIfInit, [{ form }], site => sites.push(site));
    assert.equal(sites[0]?.applied, false);

    const withAttribute = parse(base) as TranslationUnit;
    const attrFn = withAttribute.declarations[0] as FunctionDecl;
    const decl = (attrFn.body!.statements[0] as unknown as { declarations: VariableDecl[] }).declarations[0]!;
    decl.attributes.push({ kind: 'Attribute', name: 'maybe_unused' } as never);
    const attrSites: Vc8FormSite[] = [];
    applyVc8Forms(withAttribute, [{ form }], site => attrSites.push(site));
    assert.equal(attrSites[0]?.applied, false);
  });
});

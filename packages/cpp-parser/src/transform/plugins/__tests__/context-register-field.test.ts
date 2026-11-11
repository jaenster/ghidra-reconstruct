/**
 * Context Register Field Plugin Tests
 *
 * The rewrite must leave the x86 expression exactly as it was once the macro
 * expands: the object, the member and the lvalue. So the expected text pins the
 * object spelled into the accessor (a pointer is dereferenced, never copied),
 * and the must-not cases pin that only a CONTEXT is touched.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import {
  contextRegisterFieldPlugin, CONTEXT_FIELD_SUPPORT_LINES,
} from '../builtins/context-register-field.js';

describe('contextRegisterFieldPlugin', () => {
  const transform = (code: string, options?: Record<string, unknown>): string => {
    const t = contextRegisterFieldPlugin.createTransformer(options as never);
    return emit(t(parse(code)) as AnyNode).replace(/\s+/g, '');
  };

  it('reads a register of a local CONTEXT through the accessor', () => {
    const out = transform(`void f() { CONTEXT c; g((void*)c.Esp, c.Eip); }`);
    assert.ok(out.includes('g((void*)D2_CONTEXT_FIELD(c,Esp),D2_CONTEXT_FIELD(c,Eip))'), out);
  });

  it('dereferences a CONTEXT pointer into the accessor and keeps the store', () => {
    const out = transform(`void f(CONTEXT* p, DWORD n) { p->Ebp = n; n = p->Eip; }`);
    assert.ok(out.includes('D2_CONTEXT_FIELD(*p,Ebp)=n;'), out);
    assert.ok(out.includes('n=D2_CONTEXT_FIELD(*p,Eip);'), out);
  });

  it('takes the SDK pointer typedefs', () => {
    const out = transform(`void f(LPCONTEXT p) { g(p->Esp); }`);
    assert.ok(out.includes('g(D2_CONTEXT_FIELD(*p,Esp))'), out);
  });

  it('follows a frame group member declared in the body', () => {
    const out = transform(`void f(CONTEXT* pc) { struct __frame1_t { CONTEXT* pCopy; }; __frame1_t fr; fr.pCopy = pc; g(fr.pCopy->Esp); }`);
    assert.ok(out.includes('g(D2_CONTEXT_FIELD(*fr.pCopy,Esp))'), out);
  });

  it('writes the x87 area as a whole and keeps the other FloatSave members', () => {
    const out = transform(`void f() { CONTEXT c; uint8_t* p; DWORD w; p = c.FloatSave.RegisterArea + 8; w = c.FloatSave.ControlWord; }`);
    assert.ok(out.includes('p=D2_CONTEXT_X87_AREA(c)+8;'), out);
    assert.ok(out.includes('w=D2_CONTEXT_FIELD(c,FloatSave).ControlWord;'), out);
  });

  it('leaves the members every target has', () => {
    const out = transform(`void f(CONTEXT* p) { p->ContextFlags = 0x10007; g(&p->Dr0, p->EFlags, p->SegCs); }`);
    assert.ok(!out.includes('D2_CONTEXT'), out);
  });

  it('leaves a register-named field of another struct', () => {
    const out = transform(`void f(D2RegsStrc* p) { g(p->Eip); D2RegsStrc r; g(r.Esp); }`);
    assert.ok(!out.includes('D2_CONTEXT'), out);
  });

  it('leaves a member whose object type is unknown', () => {
    const out = transform(`void f() { g(pUnknown->Eip); }`);
    assert.ok(!out.includes('D2_CONTEXT'), out);
  });

  it('expands to the member access itself on x86', () => {
    const text = CONTEXT_FIELD_SUPPORT_LINES.join('\n');
    const x86 = text.slice(text.indexOf('#else'));
    assert.ok(x86.includes('#define D2_CONTEXT_FIELD(c, f) ((c).f)'), text);
    assert.ok(x86.includes('#define D2_CONTEXT_X87_AREA(c) ((c).FloatSave.RegisterArea)'), text);
    assert.ok(text.includes('#define D2_CONTEXT_X64_Eip Rip'), text);
  });
});

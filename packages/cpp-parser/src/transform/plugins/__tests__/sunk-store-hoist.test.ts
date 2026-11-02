/**
 * sunk-store-hoist: a stack element store the decompiler printed after a read through the
 * object's address goes back in front of that read - and nowhere else.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { sunkStoreHoistPlugin } from '../builtins/sunk-store-hoist.js';

function run(src: string): string {
  const t = sunkStoreHoistPlugin.createTransformer();
  return emit(t(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();
}

function unchanged(src: string): void {
  assert.equal(run(src), emit(parse(src) as AnyNode).replace(/\s+/g, ' ').trim());
}

const DECLS = 'char szPath[32]; char szCode[4]; char* p; char c; int k;';

describe('sunk-store-hoist', () => {
  it('PALSHIFT_LoadMonsterPalShift 00477170: the code bytes go back before strcat reads them', () => {
    const out = run(`void f(char c0, char c1) { ${DECLS} szCode[3] = 0; szCode[2] = 0; memcpy(szPath, "Data", 5);
      strcat(szPath, szCode); p = szPath + 4; szCode[1] = c1; szCode[0] = c0; Open(szPath); }`);
    assert.match(out, /szCode\[2\] = 0; memcpy\(szPath, "Data", 5\); szCode\[1\] = c1; szCode\[0\] = c0; strcat\(szPath, szCode\); p = szPath \+ 4; Open\(szPath\);/);
  });

  it('the decompiler shape: the stores go before the scan loop over a pointer to the buffer', () => {
    const out = run(`void f(char c0) { ${DECLS} szCode[1] = 0; p = szCode; do { c = *p; p = p + 1; } while (c != 0);
      k = (int)p - (int)szCode; szCode[0] = c0; Open(szPath); }`);
    assert.match(out, /p = szCode; szCode\[0\] = c0; do \{/);
    assert.match(out, /k = \(int\)p - \(int\)szCode; Open\(szPath\);/);
  });

  it('a constant-offset slice store moves too', () => {
    const out = run(`void f(short w) { char szCode[8]; int k; k = strlen(szCode); *(short*)((char*)&szCode + 2) = w; Open(k); }`);
    assert.match(out, /\*\(short int\*\)\(\(char\*\)&szCode \+ 2\) = w; k = strlen\(szCode\); Open\(k\);/);
  });

  it('leaves a store when a callee anywhere in the function is handed the buffer', () => {
    unchanged(`void f(short w) { char szCode[8]; int k; k = strlen(szCode); *(short*)((char*)&szCode + 2) = w; Open(szCode); }`);
  });

  it('leaves a store after a callee that may write the buffer', () => {
    unchanged(`void f(char c0) { ${DECLS} GetName(szCode); strcat(szPath, szCode); szCode[3] = 0; Open(szPath); }`);
  });

  it('leaves a store after strcpy into the buffer', () => {
    unchanged(`void f(char c0) { ${DECLS} strcpy(szCode, "ab"); strcat(szPath, szCode); szCode[3] = 0; Open(szPath); }`);
  });

  it('leaves a store whose value is computed in between', () => {
    unchanged(`void f(char c0) { ${DECLS} strcat(szPath, szCode); c0 = 5; szCode[0] = c0; Open(szPath); }`);
  });

  it('leaves a store whose element is read directly in between', () => {
    unchanged(`void f(char c1) { ${DECLS} strcat(szPath, szCode); k = szCode[1]; szCode[1] = c1; Open(szPath); }`);
  });

  it('leaves a store when the element is also written elsewhere', () => {
    unchanged(`void f(char c0, int n) { ${DECLS} if (n) { szCode[0] = 1; } strcat(szPath, szCode); szCode[0] = c0; Open(szPath); }`);
    unchanged(`void f(char c0) { char szPath[32]; char szCode[4] = {0}; strcat(szPath, szCode); szCode[0] = c0; Open(szPath); }`);
  });

  it('leaves a store when a pointer to the buffer is written through', () => {
    unchanged(`void f(char c0) { ${DECLS} p = szCode; k = *p; *p = 1; szCode[0] = c0; Open(szPath); }`);
  });

  it('leaves a store with no read between the address-take and it - the order is unobservable', () => {
    unchanged(`void f(char c0) { ${DECLS} p = szCode; szCode[0] = c0; Open(p); }`);
  });

  it('leaves a store with a label, goto or break between the read and it', () => {
    unchanged(`void f(char c0, int n) { ${DECLS} strcat(szPath, szCode); again: k = n; szCode[0] = c0; if (n) goto again; Open(szPath); }`);
    unchanged(`void f(char c0, int n) { ${DECLS} while (n) { strcat(szPath, szCode); if (k) break; szCode[0] = c0; n--; } }`);
  });

  it('leaves a store that loads memory when a call in between may change it', () => {
    unchanged(`void f(char* pSrc) { char szPath[32]; char szCode[4]; strcat(szPath, szCode); szCode[0] = *pSrc; Open(szPath); }`);
    unchanged(`void f() { char szPath[32]; char szCode[4]; strcat(szPath, szCode); szCode[0] = gCode; Open(szPath); }`);
  });

  it('leaves an unknown call between the read and the store', () => {
    unchanged(`void f(char c0) { ${DECLS} strcat(szPath, szCode); Log(szPath); szCode[0] = c0; Open(szPath); }`);
  });

  it('leaves a field store after a memset, and a slice read of a struct (a direct access)', () => {
    unchanged(`void f(int a) { D2PacketStrc s; memset(&s, 0, sizeof(s)); s.nType = a; Send(&s); }`);
    unchanged(`void f(int a) { D2PathNodeStrc s; int d; d = *(uint32_t*)((char*)&s + 8) - a; s.nCost = d; Go(*(uint32_t*)((char*)&s + 8)); }`);
  });

  it('leaves a struct whose address a callee receives anywhere', () => {
    unchanged(`void f(int a) { D2PacketStrc s; D2PacketStrc t; Fill(&s); memcpy(&t, &s, 8); s.nType = a; Send(&t); }`);
  });
});

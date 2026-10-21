/**
 * label-unreferenced-drop: the last control-flow step drops every label no goto names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from '../../../parser/index.js';
import { emit } from '../../../emit/index.js';
import type { AnyNode } from '../../../ast/nodes.js';
import { labelUnreferencedDropPlugin } from '../builtins/label-unreferenced-drop.js';
import { allBuiltinPlugins } from '../index.js';

const run = (src: string) =>
  emit(labelUnreferencedDropPlugin.createTransformer()(parse(src)) as AnyNode).replace(/\s+/g, ' ').trim();

describe('label-unreferenced-drop', () => {
  it("drops the label dead-branch-cleanup's removal of Ghidra's `if (false) goto L` left (AUTOMAP_RebalanceTreeRight 00457900)", () => {
    const out = run(`void f(int *p) { if (*p == -1) { LAB_00457946: p[0] = 0; p[1] = 0; } use(p); }`);
    assert.doesNotMatch(out, /LAB_00457946/);
    assert.match(out, /if \(\*p == -1\) \{ p\[0\] = 0; p\[1\] = 0; \}/);
  });

  it('keeps a label any goto of the function still names, from any depth', () => {
    const out = run(`void f(int a) { L1: x(); if (a) { while (a) { if (y()) goto L1; } } L2: z(); }`);
    assert.match(out, /L1: x\(\);/);
    assert.doesNotMatch(out, /L2/);
  });

  it('keeps the statement where a statement is required, drops an empty one in a block', () => {
    const out = run(`void f(int a) { switch (a) { case 1: L1: ; break; default: L2: y(); } if (a) L3: ; x(); L4: ; }`);
    assert.doesNotMatch(out, /L[1-4]:/);
    assert.match(out, /case 1: break;/);
    assert.match(out, /default: y\(\);/);
    assert.match(out, /if \(a\) ;/);
    assert.match(out, /x\(\); \}$/);
  });

  it('peels only the unreferenced label of a chain', () => {
    const out = run(`void f(int a) { if (a) goto L2; L1: L2: x(); }`);
    assert.doesNotMatch(out, /L1/);
    assert.match(out, /L2: x\(\);/);
  });

  it('counts gotos per function: the same name in another function does not keep it', () => {
    const out = run(`void f() { L: x(); } void g() { goto L; L: y(); }`);
    assert.match(out, /void f\(\) \{ x\(\); \}/);
    assert.match(out, /goto L; L: y\(\);/);
  });

  it('runs after every pass that can add or remove a goto', () => {
    const prio = (id: string) => allBuiltinPlugins.find(p => p.id === id)!.priority;
    for (const id of ['goto-cleanup', 'dead-branch-cleanup', 'halt-site-fold', 'switch-case-dedup', 'duplicate-label-uniquify', 'goto-crosses-init', 'undefined-goto-label', 'goto-label-restore']) {
      assert.ok(prio('label-unreferenced-drop') > prio(id), `${id} runs after the drop`);
    }
  });
});

describe('emitter: an empty statement is printed where one is required', () => {
  it('`if (a) ;` keeps its empty body and `L: ;` its statement', () => {
    const out = emit(parse(`void f(int a) { if (a) ; x(); while (a) ; if (a) L: ; y(); goto L; }`) as AnyNode).replace(/\s+/g, ' ');
    assert.match(out, /if \(a\) ; x\(\);/);
    assert.match(out, /while \(a\) ;/);
    assert.match(out, /if \(a\) L: ; y\(\);/);
  });
});

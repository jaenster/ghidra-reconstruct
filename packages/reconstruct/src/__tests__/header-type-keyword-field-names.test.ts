/**
 * Regression test: a struct field whose name is a C++ *type* keyword must be
 * suffixed with `_`, exactly like the non-type keywords already are.
 *
 * CPP_KEYWORDS deliberately excluded int/char/float/... on the assumption that
 * "those don't arise as bare field names". They do: Ghidra names D2 data-table
 * structs after the .txt column headers, and CharTemplate.txt has a column
 * named `int` (Intelligence). D2CharTemplateTxt therefore emitted
 *
 *     char int;
 *
 * which is `error: multiple types in one declaration`. Because ArenaTbls.h is
 * pulled in transitively, that single field broke *every* translation unit in
 * the tree that reached it.
 *
 * Fixture is the real 1.14d Game.exe layout at D2CharTemplateTxt+0x1e.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { generateStructDeclaration, CPP_KEYWORDS } from '../codegen/header.js';
import type { ExtractedStruct } from '../types.js';

/** D2CharTemplateTxt 0x1e..0x28 - the CharTemplate.txt column names. */
const CHAR_TEMPLATE_TXT: ExtractedStruct = {
  kind: 'STRUCTURE',
  name: 'D2CharTemplateTxt',
  category: '/test',
  size: 0x29,
  fields: [
    { name: 'Name', dataType: 'char[29]', offset: 0x00, size: 29 },
    { name: 'class', dataType: 'char', offset: 0x1e, size: 1 },
    { name: 'level', dataType: 'char', offset: 0x1f, size: 1 },
    { name: 'act', dataType: 'char', offset: 0x20, size: 1 },
    { name: 'str', dataType: 'char', offset: 0x21, size: 1 },
    { name: 'dex', dataType: 'char', offset: 0x22, size: 1 },
    { name: 'int', dataType: 'char', offset: 0x23, size: 1 },
    { name: 'vit', dataType: 'char', offset: 0x24, size: 1 },
    { name: 'Mana', dataType: 'char', offset: 0x25, size: 1 },
  ],
};

describe('struct fields named after C++ type keywords', () => {
  it('suffixes a field literally named `int`', () => {
    const out = generateStructDeclaration(CHAR_TEMPLATE_TXT);

    // `char int;` is a syntax error - it must come out as `int_`.
    assert.doesNotMatch(out, /\bchar\s+int\s*;/);
    assert.match(out, /\bchar\s+int_\s*;/);
  });

  it('leaves neighbouring non-keyword columns untouched', () => {
    const out = generateStructDeclaration(CHAR_TEMPLATE_TXT);

    // str/dex/vit are not keywords - they must not gain a suffix.
    assert.match(out, /\bchar\s+str\s*;/);
    assert.match(out, /\bchar\s+dex\s*;/);
    assert.match(out, /\bchar\s+vit\s*;/);
    // `class` was already handled and must stay handled.
    assert.match(out, /\bchar\s+class_\s*;/);
  });

  it('covers every type keyword Ghidra can pick up as a column name', () => {
    for (const kw of ['int', 'char', 'float', 'double', 'short', 'long',
                      'bool', 'void', 'signed', 'unsigned', 'auto']) {
      assert.ok(CPP_KEYWORDS.has(kw), `CPP_KEYWORDS is missing '${kw}'`);
    }
  });

  it('does not suffix identifiers that merely start with a keyword', () => {
    const struct: ExtractedStruct = {
      kind: 'STRUCTURE',
      name: 'NearMissStrc',
      category: '/test',
      size: 8,
      fields: [
        { name: 'intValue', dataType: 'int', offset: 0, size: 4 },
        { name: 'charCount', dataType: 'int', offset: 4, size: 4 },
      ],
    };

    const out = generateStructDeclaration(struct);

    assert.match(out, /\bintValue\s*;/);
    assert.match(out, /\bcharCount\s*;/);
    assert.doesNotMatch(out, /intValue_/);
    assert.doesNotMatch(out, /charCount_/);
  });
});

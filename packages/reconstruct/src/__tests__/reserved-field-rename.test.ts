/**
 * A struct field whose name is a C++ keyword is renamed at DECLARATION time
 * (header.ts, `int` → `int_`). Every REFERENCE to it must be renamed from that
 * same map — on the member-access node, so the identical characters inside a
 * string literal or a comment are left alone.
 *
 * Fixture is the real 1.14d layout: CharTemplate.txt has an `int`
 * (Intelligence) column, so D2CharTemplateTxt carries a field named `int`.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';

import {
  generateImplementation,
  setStructFieldRenames,
  getStructFieldRenames,
} from '../codegen/impl.js';
import { generateStructDeclaration } from '../codegen/header.js';
import type { ExtractedFunction, ExtractedStruct, ReconstructOptions } from '../types.js';

const CHAR_TEMPLATE_TXT: ExtractedStruct = {
  kind: 'STRUCTURE',
  name: 'D2CharTemplateTxt',
  category: '/test',
  size: 0x29,
  fields: [
    { name: 'Name', dataType: 'char[29]', offset: 0x00, size: 29 },
    { name: 'class', dataType: 'char', offset: 0x1e, size: 1 },
    { name: 'str', dataType: 'char', offset: 0x21, size: 1 },
    { name: 'int', dataType: 'char', offset: 0x23, size: 1 },
    { name: 'vit', dataType: 'char', offset: 0x24, size: 1 },
  ],
};

const options: ReconstructOptions = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'flat',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
  promoteStaticGlobals: false,
};

const FUNC: ExtractedFunction = {
  name: 'CHARTEMPLATE_GetInt',
  address: '0x00400000',
  signature: 'int CHARTEMPLATE_GetInt(D2CharTemplateTxt * pTemplate)',
  returnType: 'int',
  parameters: [{ name: 'pTemplate', dataType: 'D2CharTemplateTxt *', size: 4, ordinal: 0 }],
  localVariables: [],
  callingConvention: '__fastcall',
  size: 32,
  isThunk: false,
  isExternal: false,
  hasVarArgs: false,
  decompiled: [
    'int CHARTEMPLATE_GetInt(D2CharTemplateTxt *pTemplate)',
    '{',
    '  int nInt;',
    '  char *pszField;',
    '  nInt = pTemplate->int;',
    '  pszField = "->int";',
    '  // ->int is a comment, not a member access',
    '  nInt = nInt + pTemplate->class;',
    '  return nInt;',
    '}',
  ].join('\n'),
};

describe('references to a field the header renamed because it is a C++ keyword', () => {
  before(() => setStructFieldRenames([CHAR_TEMPLATE_TXT]));

  it('builds the rename map from the declared struct model', () => {
    assert.deepStrictEqual(getStructFieldRenames(), { class: 'class_', int: 'int_' });
  });

  it('agrees with the name the declaration actually emits', () => {
    const decl = generateStructDeclaration(CHAR_TEMPLATE_TXT);
    for (const [raw, renamed] of Object.entries(getStructFieldRenames())) {
      assert.match(decl, new RegExp(`\\b${renamed}\\s*;`), `declaration should emit ${renamed}`);
      assert.doesNotMatch(decl, new RegExp(`\\bchar\\s+${raw}\\s*;`));
    }
  });

  it('renames the member access to match the declaration', () => {
    const impl = generateImplementation(
      'CharTemplate', [FUNC], undefined, 'CharTemplate.h', options, {}, undefined, new Set<string>(),
    );

    assert.ok(impl.includes('pTemplate->int_'), `expected pTemplate->int_ — got:\n${impl}`);
    assert.ok(impl.includes('pTemplate->class_'), `expected pTemplate->class_ — got:\n${impl}`);
  });

  it('leaves the same characters in a string literal and a comment alone', () => {
    const impl = generateImplementation(
      'CharTemplate', [FUNC], undefined, 'CharTemplate.h', options, {}, undefined, new Set<string>(),
    );

    assert.ok(impl.includes('"->int"'), `string literal must not be rewritten — got:\n${impl}`);
    assert.ok(
      !impl.includes('"->int_"'),
      `string literal must not be rewritten — got:\n${impl}`,
    );
    assert.ok(
      !/\/\/[^\n]*->int_/.test(impl),
      `comment must not be rewritten — got:\n${impl}`,
    );
  });

  it('does not rename a member that was never renamed at declaration time', () => {
    const impl = generateImplementation(
      'CharTemplate', [FUNC], undefined, 'CharTemplate.h', options, {}, undefined, new Set<string>(),
    );

    assert.ok(!impl.includes('str_'), `str is not a keyword — got:\n${impl}`);
  });
});

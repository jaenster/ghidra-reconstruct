/**
 * Every class's vftable is its own datum.
 *
 * Ghidra hangs a class's `vftable` (and its RTTI records) under a namespace
 * named after the class: `D2Client::ButtonImplementation::vftable`,
 * `D2Client::ButtonWrapper::vftable`, `D2Client::UIWidget::vftable`. The
 * namespace rule drops a LAST segment that names a struct, so all of them
 * resolved to `D2Client::vftable`; the globals emitters keep the first datum of
 * a name and silently drop the rest. In the 1.14d tree ten widget/ChatIgnoreList
 * tables became one `pointer vftable[12]` of `__purecall`s, and every widget
 * constructor installed it - the first virtual call on the gold dialog, the
 * merc list or the message log would land in `__purecall`.
 *
 * Emitted C++ is read back through the cpp-parser AST, never matched as text.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { parse } from '@ghidra-mcp/cpp-parser';
import { resolveProgramNamespaces, buildFuncPtrArgCastTables } from '../codegen/index.js';
import { namespaceResolution, renderNamespace } from '../codegen/namespace-resolution.js';
import { normalizeQualifiedReference } from '../codegen/namespace.js';
import { generateHeader } from '../codegen/header.js';
import {
  generateGlobalsHeader,
  generateGlobalsImpl,
  setUnopenableRootNames,
} from '../codegen/globals-header.js';
import type { AnalyzedDataSymbol, ExtractedDataType, ExtractedFunction, ReconstructOptions } from '../types.js';

const options = {
  outputDir: '/tmp/test',
  format: 'cpp',
  organization: 'namespace',
  generateCMake: false,
  generateSourceMaps: false,
  transformPreset: 'full',
  includeAddressComments: false,
} as ReconstructOptions & { projectName?: string; binaryName?: string };

const STRUCTS = ['UIWidget', 'ButtonImplementation', 'ButtonWrapper', 'Direct3D']
  .map(name => ({ kind: 'STRUCTURE', name } as ExtractedDataType));

/** A 1.14d vftable: `pointer[N]` whose elements name the slot functions. */
function vftable(cls: string, address: string, slots: string[]): AnalyzedDataSymbol {
  return {
    name: 'vftable',
    address,
    namespace: `D2Client::${cls}`,
    dataType: `pointer[${slots.length}]`,
    size: slots.length * 4,
    isInitialized: true,
    xrefCount: 2,
    scope: 'global',
    initializedData: {
      kind: 'array',
      value: null,
      elements: slots.map(value => ({ kind: 'pointer', value, elements: null, fields: null })),
    },
  } as unknown as AnalyzedDataSymbol;
}

const UIWIDGET = vftable('UIWidget', '006da6c0', ['compiler::__purecall', 'compiler::__purecall']);
const BUTTON = vftable('ButtonImplementation', '006da6f4', [
  'D2Client::ButtonImplementation::BUTTON_ScalarDeletingDestructor',
  'D2Client::ButtonImplementation::BUTTON_Draw',
]);
const WRAPPER = vftable('ButtonWrapper', '006da72c', [
  'D2Client::ButtonWrapper::BUTTONWRAPPER_ScalarDeletingDestructor',
  'D2Client::ButtonWrapper::BUTTONWRAPPER_FwdDraw',
]);
/** Alone under its class: nothing to merge with, so the class still folds away. */
const LONE: AnalyzedDataSymbol = {
  name: 'pD3DDevice', address: '0070a000', namespace: 'D2Client::Renderer::Direct3D',
  dataType: 'int', size: 4, scope: 'global',
} as AnalyzedDataSymbol;
/** A member function of a class whose vftable is kept apart. */
const DRAW = {
  name: 'BUTTON_Draw', address: '004bb000', namespace: 'D2Client::ButtonImplementation',
} as ExtractedFunction;

function resolveModel(): void {
  setUnopenableRootNames(new Set());
  resolveProgramNamespaces(STRUCTS, [DRAW], [UIWIDGET, BUTTON, WRAPPER, LONE]);
}

type Def = { ns: string; slots: string[] };

/**
 * Every `vftable` variable in a parsed unit, with its namespace and slot
 * targets: the DEFINITIONS (initialized) or the declarations without one.
 */
function vftables(source: string, defined = true): Def[] {
  const out: Def[] = [];
  const name = (n: any): string =>
    n.kind === 'QualifiedId'
      ? [...n.qualifier.map((q: any) => q.name), n.name.name].join('::')
      : n.name;
  const target = (e: any): string => {
    while (e.kind === 'CStyleCastExpr' || e.kind === 'ParenExpr') e = e.expression;
    return e.kind === 'UnaryExpr' && e.operator === '&' ? name(e.operand) : name(e);
  };
  const visit = (node: any, ns: string[]): void => {
    if (node.kind === 'NamespaceDecl') {
      const segs = name(node.name).split('::');
      for (const d of node.declarations) visit(d, [...ns, ...segs]);
    } else if (node.kind === 'VariableDecl' && node.name.name === 'vftable') {
      if (!!node.initializer !== defined) return;
      out.push({ ns: ns.join('::'), slots: node.initializer?.elements?.map(target) ?? [] });
    } else if (Array.isArray(node.declarations)) {
      for (const d of node.declarations) visit(d, ns);
    }
  };
  visit(parse(source), []);
  return out;
}

describe('class vftables stay apart', () => {
  it('each vftable resolves into its own class namespace', () => {
    resolveModel();
    const r = namespaceResolution();
    assert.strictEqual(renderNamespace(r.of(UIWIDGET)), 'D2Client::UIWidget');
    assert.strictEqual(renderNamespace(r.of(BUTTON)), 'D2Client::ButtonImplementation');
    assert.strictEqual(renderNamespace(r.of(WRAPPER)), 'D2Client::ButtonWrapper');
  });

  it('leaves everything else on the old rule', () => {
    resolveModel();
    const r = namespaceResolution();
    // A function survives the fold as an overload; only data is kept apart.
    assert.strictEqual(renderNamespace(r.of(DRAW)), 'D2Client');
    // A datum alone under its class merges with nothing.
    assert.strictEqual(renderNamespace(r.of(LONE)), 'D2Client::Renderer');
  });

  it('globals.cpp defines every table with its own slots', () => {
    resolveModel();
    const defs = vftables(generateGlobalsImpl([UIWIDGET, BUTTON, WRAPPER, LONE], options));
    assert.deepStrictEqual(
      defs.sort((a, b) => a.ns.localeCompare(b.ns)),
      [
        { ns: 'D2Client::ButtonImplementation', slots: ['D2Client::BUTTON_ScalarDeletingDestructor', 'D2Client::BUTTON_Draw'] },
        { ns: 'D2Client::ButtonWrapper', slots: ['D2Client::BUTTONWRAPPER_ScalarDeletingDestructor', 'D2Client::BUTTONWRAPPER_FwdDraw'] },
        { ns: 'D2Client::UIWidget', slots: ['__purecall', '__purecall'] },
      ],
    );
  });

  it('globals.h declares every table once, in the scope it is defined in', () => {
    resolveModel();
    const decls = vftables(generateGlobalsHeader([UIWIDGET, BUTTON, WRAPPER, LONE], options), false);
    assert.deepStrictEqual(
      decls.map(d => d.ns).sort(),
      ['D2Client::ButtonImplementation', 'D2Client::ButtonWrapper', 'D2Client::UIWidget'],
    );
  });

  it('a reference names the table of its own class', () => {
    resolveModel();
    // Initializers and bodies carry Ghidra's path; the declaration kept the class.
    assert.strictEqual(
      normalizeQualifiedReference('D2Client::ButtonWrapper::vftable'),
      'D2Client::ButtonWrapper::vftable',
    );
    assert.deepStrictEqual(
      namespaceResolution().keptReferenceNames().sort(),
      [
        'D2Client::ButtonImplementation::vftable',
        'D2Client::ButtonWrapper::vftable',
        'D2Client::UIWidget::vftable',
      ],
    );
    // A function reference through the same class still folds.
    assert.strictEqual(
      normalizeQualifiedReference('D2Client::ButtonImplementation::BUTTON_Draw'),
      'D2Client::BUTTON_Draw',
    );
  });
});

describe('a destructor-named function reaches a vftable initializer', () => {
  it('its legalized spelling carries its signature', () => {
    // `~EditBoxImplementation` is slot 0 of EditBoxImplementation's vftable. It is
    // defined as `_EditBoxImplementation`, which is the spelling the initializer
    // sees; without its signature the slot got no `(void*)` cast and a function
    // pointer does not convert to `pointer` implicitly.
    setUnopenableRootNames(new Set());
    const dtor = {
      name: '~EditBoxImplementation', address: '004bbd50',
      namespace: 'D2Client::EditBoxImplementation',
      returnType: 'EditBoxImplementation *',
      parameters: [
        { name: 'pEditBoxImpl', dataType: 'EditBoxImplementation *', ordinal: 0 },
        { name: 'nDelete', dataType: 'bool', ordinal: 1 },
      ],
    } as unknown as ExtractedFunction;
    resolveProgramNamespaces(
      [{ kind: 'STRUCTURE', name: 'EditBoxImplementation' }], [dtor], [],
    );
    const t = buildFuncPtrArgCastTables([dtor], [], [], []);
    assert.ok(t.functionSignatures['D2Client::_EditBoxImplementation'] !== undefined);
  });

  it('its header declares it under the name its definition carries', () => {
    // The header skipped every `~Name` function while the definition emitted it
    // as `_Name`, so the vftable initializer named something nothing declared.
    setUnopenableRootNames(new Set());
    const dtor = {
      name: '~EditBoxImplementation', address: '004bbd50', namespace: 'D2Client',
      returnType: 'void', parameters: [], callingConvention: '__cdecl',
    } as unknown as ExtractedFunction;
    resolveProgramNamespaces([], [dtor], []);
    const header = generateHeader('EditBoxImplementation', [dtor], undefined, [], [], options);
    const declared: string[] = [];
    const visit = (node: any): void => {
      if (node.kind === 'FunctionDecl') declared.push(node.name.name);
      for (const d of node.declarations ?? []) visit(d);
    };
    visit(parse(header));
    assert.deepStrictEqual(declared, ['_EditBoxImplementation']);
  });
});

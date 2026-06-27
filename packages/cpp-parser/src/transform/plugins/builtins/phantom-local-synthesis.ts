/**
 * Phantom-Local Synthesis Plugin
 *
 * Ghidra's decompiler sometimes references an auto-named temporary in a function
 * body (`uVar3`, `iVar1`, `unique0x0000a300`, …) that is NOT in the function's
 * declared-variable list — so the emitted body uses an undeclared identifier
 * (`'uVar3' was not declared in this scope`). The same name is a normal declared
 * local in most other functions; here it's a phantom the var-list dropped.
 *
 * For every used-but-undeclared identifier matching a Ghidra auto-name pattern,
 * synthesize `<inferredType> <name>;` at the top of the body. The type comes from
 * Ghidra's Hungarian naming convention (the prefix encodes the type), so a
 * pointer-named phantom (`puVar`) gets a pointer type, not a scalar — avoiding
 * trading a "not declared" error for a "non-pointer deref" one.
 *
 * Modelled on the underscore-slot-local plugin; runs LATE so decl-cleanup passes
 * don't strip the synthesized declarations.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, VariableDecl, ParameterDecl, Identifier, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Decl, Stmt, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface PhantomLocalSynthesisOptions extends PluginOptions {}

/**
 * Infer a phantom's type from its Ghidra auto-name, or null if the name is not a
 * recognised auto-name (so we never synthesize for a real identifier).
 *   leading `p`s = pointer levels; the scalar letter picks the base type.
 *   uVar/uStack→uint32_t, iVar/iStack→int32_t, bVar→bool, cVar→char, sVar→int16_t,
 *   fVar→float, dVar→double, unique0x…→uint32_t.
 */
function inferPhantomType(name: string): TypeNode | null {
  // p* pointer prefix over a scalar auto-name: puVar3, ppcVar1, apuStack_10, …
  let m = name.match(/^(a?)(p+)([a-z])(?:[A-Za-z]*Var\d+|[A-Za-z]*Stack_?[0-9a-fA-F]+)$/);
  if (m) {
    const base = scalarBase(m[3]);
    if (!base) return null;
    let t: TypeNode = Type.builtin(base);
    for (let i = 0; i < m[2].length; i++) t = Type.pointer(t);
    return t;
  }
  // scalar auto-name: uVar3, iVar1, bVar2, auStack_28, unique0x0000a300
  m = name.match(/^(a?)([a-z])(?:[A-Za-z]*Var\d+|[A-Za-z]*Stack_?[0-9a-fA-F]+)$/);
  if (m) {
    const base = scalarBase(m[2]);
    return base ? Type.builtin(base) : null;
  }
  if (/^unique0x[0-9a-fA-F]+$/.test(name)) return Type.builtin('uint32_t');
  return null;
}

function scalarBase(letter: string): string | null {
  switch (letter) {
    case 'u': return 'uint32_t';
    case 'i': return 'int32_t';
    case 'b': return 'uint8_t';
    case 'c': return 'char';
    case 's': return 'int16_t';
    case 'f': return 'float';
    case 'd': return 'double';
    default: return null;
  }
}

function createPhantomLocalSynthesisTransformer(_options: PhantomLocalSynthesisOptions = {}): Transformer {
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const declared = new Set<string>();
      for (const p of node.parameters) declared.add((p as ParameterDecl).name.name);
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        declared.add((d as VariableDecl).name.name);
      }

      const synth = new Map<string, TypeNode>();
      for (const id of findNodesByKind(node.body, NodeKind.Identifier)) {
        const name = (id as Identifier).name;
        if (declared.has(name) || synth.has(name)) continue;
        const type = inferPhantomType(name);
        if (type) synth.set(name, type);
      }
      if (synth.size === 0) return undefined;

      const decls = [...synth.entries()].map(([name, type]) => Stmt.declStmt([Decl.variable(name, type)]));
      const newBody = updateNode(node.body, {
        statements: [...decls, ...node.body.statements],
      } as Partial<CompoundStmt>);
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const phantomLocalSynthesisPlugin: TransformPlugin = {
  id: 'phantom-local-synthesis',
  name: 'Phantom-Local Synthesis',
  description: 'Declares Ghidra auto-name temporaries (uVar3, unique0x…) used in a body but absent from its var list',
  version: '1.0.0',
  defaultEnabled: true,
  // Run LATE (after boilerplate-cleanup at 500), same reason as underscore-slot.
  priority: 601,
  tags: ['cleanup', 'declaration'],
  createTransformer: createPhantomLocalSynthesisTransformer,
};

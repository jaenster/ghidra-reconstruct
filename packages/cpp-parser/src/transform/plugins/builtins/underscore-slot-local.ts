/**
 * Underscore Storage-Slot Local Synthesis Plugin
 *
 * Ghidra's decompiler reuses a parameter/local's STORAGE SLOT as a fresh local
 * after the original value is dead, rendering it `_<base>` (one leading underscore
 * over `<base>`) but emitting no declaration — so the body uses an undeclared
 * identifier (`'_foo' was not declared; did you mean 'foo'?`).
 *
 * For every `_<base>` referenced in the body where `<base>` is a declared
 * parameter/local and `_<base>` itself is not declared, synthesize a
 * `<baseType> _<base>;` at the top of the body, reusing the base's type.
 *
 * AST-based: `_<base>` and `<base>` are real Identifier/VariableDecl nodes, so —
 * unlike the previous text-level pass — `return _bResult;` is unambiguously a
 * ReturnStmt (not a declaration), and we read the base's TypeNode directly instead
 * of re-parsing a type string. Skips `_DAT_*` / `_LAB_*` (globals/labels).
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, CompoundStmt, VariableDecl, ParameterDecl, Identifier, TypeNode,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Decl, Stmt, Type } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface UnderscoreSlotLocalOptions extends PluginOptions {
  /** name → Ghidra type string for params/locals not visible in the transform AST
   *  (the body is wrapped as a param-less `void dummy(){...}`). */
  varTypes?: Record<string, string>;
}

/** Minimal Ghidra type-string → TypeNode: base name + trailing pointer levels. */
function buildTypeFromString(s: string): TypeNode {
  let str = s.trim();
  let ptr = 0;
  while (str.endsWith('*')) { ptr++; str = str.slice(0, -1).trim(); }
  str = str.replace(/^(struct|union|enum)\s+/, '').replace(/\bconst\b/g, '').trim();
  let t: TypeNode = Type.builtin(str || 'int');
  for (let i = 0; i < ptr; i++) t = Type.pointer(t);
  return t;
}

function createUnderscoreSlotLocalTransformer(options: UnderscoreSlotLocalOptions = {}): Transformer {
  const varTypes = options.varTypes ?? {};
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      // name → declared type, from params and body-declared locals (AST), plus the
      // passed param/local types (the wrapped body has no signature, so param types
      // arrive via options, built lazily from their Ghidra type string).
      const typeByName = new Map<string, TypeNode>();
      for (const p of node.parameters) typeByName.set(p.name.name, (p as ParameterDecl).type);
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!typeByName.has(v.name.name)) typeByName.set(v.name.name, v.type);
      }
      for (const [name, typeStr] of Object.entries(varTypes)) {
        if (!typeByName.has(name)) typeByName.set(name, buildTypeFromString(typeStr));
      }

      // `_<base>` identifiers used in the body where <base> is declared but
      // `_<base>` is not (so every occurrence is a use, never a declaration).
      const synth = new Map<string, TypeNode>();
      for (const id of findNodesByKind(node.body, NodeKind.Identifier)) {
        const name = (id as Identifier).name;
        if (name.length < 2 || name[0] !== '_') continue;
        if (typeByName.has(name) || synth.has(name)) continue;
        const base = name.slice(1);
        if (base.startsWith('DAT_') || base.startsWith('LAB_')) continue;
        const baseType = typeByName.get(base);
        if (baseType) synth.set(name, baseType);
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

export const underscoreSlotLocalPlugin: TransformPlugin = {
  id: 'underscore-slot-local',
  name: 'Underscore Storage-Slot Local Synthesis',
  description: 'Declares Ghidra `_<base>` storage-slot locals that are used but never declared',
  version: '1.0.0',
  defaultEnabled: true,
  // Run LAST (after boilerplate-cleanup at 500): synthesizing a declaration early
  // lets later decl-cleanup passes strip it again. The slot-local must persist.
  priority: 600,
  tags: ['cleanup', 'declaration'],
  createTransformer: createUnderscoreSlotLocalTransformer,
};

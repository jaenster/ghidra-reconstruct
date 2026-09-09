/**
 * Register-Alias Parameter Plugin
 *
 * Ghidra's calling-convention model kills EAX/ECX/EDX across every call. When a
 * callee does not actually touch them, the caller's parameter is still assumed
 * dead, so the decompiler invents a FRESH local in the same register storage.
 * The emitted C++ then declares that local, never assigns it, and uses it:
 *
 *     D2UnitStrc *pUnitUnused;                            // storage ECX
 *     D2SkillStrc *pSkillUnused;                          // storage EDX
 *     SKILLDESC_DrawElemDamageWithRange(pUnitUnused, ..., pSkillUnused, ...);
 *
 * Both are uninitialised reads, and the callee dereferences them - it is a live
 * crash, not a cosmetic one. `SKILLDESC_ElemTypeToColorIndex` @0x004e6fb0 is the
 * proven case: its whole body is 004e6fb0..004e6fd9 and writes EAX only, so ECX
 * and EDX still hold the caller's `pUnit`/`pSkill` at the call below it.
 *
 * The rewrite folds the local back onto the parameter that owns its register.
 * That is value-preserving: the body never writes the local, so every read sees
 * whatever the register held, and the shipped program only works if that is the
 * parameter. Ghidra cannot express this itself - "this callee preserves ECX"
 * lives in the cspec prototype model, not in a per-function signature - which is
 * why the correction belongs here rather than in the database.
 *
 * The pairing (local -> parameter) is computed from Ghidra's storage strings by
 * the reconstruct package and handed in as an option, because the AST cannot show
 * storage. This pass adds the safety the storage alone cannot prove: it refuses
 * any local the body assigns, increments, or takes the address of.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, Expression, Identifier } from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RegisterAliasOptions {
  /** emitted local name -> the parameter sharing its register */
  aliases?: Record<string, string>;
}

/** The identifier this expression is, ignoring parens and casts. */
function identName(expr: Expression | undefined): string | null {
  let e = expr as ASTNode | undefined;
  for (;;) {
    if (!e) return null;
    if (e.kind === NodeKind.ParenExpr) { e = (e as unknown as { expression: ASTNode }).expression; continue; }
    if (e.kind === NodeKind.CStyleCastExpr) { e = (e as unknown as { expression: ASTNode }).expression; continue; }
    break;
  }
  return e.kind === NodeKind.Identifier ? (e as unknown as Identifier).name : null;
}

/**
 * Names the body writes, increments, or takes the address of. A local that is
 * written is a genuine local whatever its storage says, so it is never folded.
 */
function assignedNames(root: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const n of traverseAST(root)) {
    if (n.kind === NodeKind.AssignExpr) {
      const nm = identName((n as unknown as { left: Expression }).left);
      if (nm) out.add(nm);
    } else if (n.kind === NodeKind.UnaryExpr) {
      const u = n as unknown as { operator: string; operand: Expression };
      if (u.operator === '&' || u.operator === '++' || u.operator === '--') {
        const nm = identName(u.operand);
        if (nm) out.add(nm);
      }
    } else if (n.kind === NodeKind.PostfixExpr) {
      // `x++` / `x--` are a separate node kind, not a UnaryExpr. Missing them
      // folded an incremented local onto its parameter - the unit test caught it.
      const nm = identName((n as unknown as { operand: Expression }).operand);
      if (nm) out.add(nm);
    }
  }
  return out;
}

function createRegisterAliasTransformer(options?: PluginOptions): Transformer {
  const aliases = ((options as RegisterAliasOptions | undefined)?.aliases) ?? {};
  const names = Object.keys(aliases);
  if (names.length === 0) return (root: ASTNode) => root;

  return (root: ASTNode) => {
    const assigned = assignedNames(root);
    const fold = new Map<string, string>();
    for (const local of names) {
      if (assigned.has(local)) continue;      // genuinely a local - leave it alone
      fold.set(local, aliases[local]);
    }
    if (fold.size === 0) return root;

    return createTransformer({
      visitNode(node: ASTNode): ASTNode | undefined {
        // Drop the now-dead declaration of the folded local.
        if (node.kind === NodeKind.VariableDecl) {
          const nm = (node as unknown as { name?: { name?: string } }).name?.name;
          if (nm && fold.has(nm)) return null as unknown as ASTNode;
          return undefined;
        }
        if (node.kind === NodeKind.Identifier) {
          const id = node as unknown as Identifier;
          const to = fold.get(id.name);
          if (to) return { ...id, name: to } as unknown as ASTNode;
        }
        return undefined;
      },
    })(root);
  };
}

export const registerAliasParamPlugin: TransformPlugin = {
  id: 'register-alias-param',
  name: 'Register-Alias Parameter',
  description:
    "Folds a never-assigned local back onto the parameter that owns its register, undoing Ghidra's assumption that every call kills EAX/ECX/EDX",
  version: '1.0.0',
  defaultEnabled: true,
  // Before the passes that reason about uninitialised reads, so they see the
  // parameter rather than a synthetic local.
  priority: 40,
  tags: ['core', 'correctness', 'ghidra'],
  createTransformer(options?: PluginOptions) {
    return createRegisterAliasTransformer(options);
  },
};

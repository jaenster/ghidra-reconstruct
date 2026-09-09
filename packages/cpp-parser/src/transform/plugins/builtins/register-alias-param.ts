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
import type { ASTNode, AnyNode, Expression, Identifier, VariableDecl } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createTransformer, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

export interface RegisterAliasOptions {
  /**
   * emitted local name -> the parameter sharing its register, and that
   * parameter's EMITTED type. The type is compared against the declaration the
   * AST holds, because that is what the compiler will see: Ghidra types these
   * locals `undefined4` while emitting them as the resolved pointer, so
   * comparing Ghidra's own type strings rejects every real case.
   */
  aliases?: Record<string, { param: string; type: string }>;
}

/** The declaration's type, spelled the way the emitter will spell it. */
function declTypeText(decl: VariableDecl): string {
  try {
    return emit(decl.type as unknown as AnyNode).replace(/\s+/g, '');
  } catch {
    return '';
  }
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
    const fold = new Map<string, { param: string; type: string }>();
    for (const local of names) {
      if (assigned.has(local)) continue;      // genuinely a local - leave it alone
      fold.set(local, aliases[local]);
    }
    if (fold.size === 0) return root;

    // Seed the declaration instead of renaming its uses and deleting it. This
    // transformer has no node-removal protocol - returning undefined means
    // "unchanged" - so a rename-and-delete leaves the declaration behind with the
    // parameter's name on it, and several locals sharing one register then emit
    // several `int pGfxData;` that redeclare and shadow the parameter. Seeding is
    // also the smaller claim: the local keeps its identity, it just starts with
    // the value the register actually held.
    return createTransformer({
      visitVariableDecl(decl: VariableDecl): VariableDecl | undefined {
        const nm = decl.name?.name;
        if (!nm) return undefined;
        const alias = fold.get(nm);
        // Never touch one that already has an initialiser - it is not the shape
        // this pass is for, whatever the storage says.
        if (!alias || decl.initializer) return undefined;
        // The seed must typecheck. Compare what the compiler will see, not what
        // Ghidra called it.
        const want = (alias.type ?? '').replace(/\s+/g, '');
        if (!want || declTypeText(decl) !== want) return undefined;
        return {
          ...decl,
          initializer: {
            kind: NodeKind.Identifier,
            name: alias.param,
            location: decl.location,
            leadingTrivia: [],
            trailingTrivia: [],
          } as unknown as Expression,
        };
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

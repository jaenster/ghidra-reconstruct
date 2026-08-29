/**
 * Code-Pointer Local Type Plugin
 *
 * `code` is Ghidra's "executable bytes, signature unknown", and `d2_platform.h`
 * spells it `typedef int code(...)`. A local Ghidra typed `code *` therefore
 * reaches the compiler as `int (*)(...)`, which is a CONCRETE C++ type that
 * converts to and from nothing:
 *
 *     code* pfnGetCurrentThread = GetCurrentThread;   // error, both directions
 *
 * The declaration is the one place where the body already says what the slot
 * holds. When a `code *` local is initialised from a plain function name and
 * every later assignment to it names the SAME function, the initialiser's type
 * is the slot's type — strictly more information than `code *`, taken from the
 * body rather than invented — so the declaration adopts it:
 *
 *     auto pfnGetCurrentThread = GetCurrentThread;
 *
 * The "same name every time" test is what keeps this honest. Ghidra hands out
 * one `code *` local per reused register, and those slots really do hold several
 * unrelated function pointers across one body:
 *
 *     code* pfnDraw;
 *     pfnDraw = (code*)(BOOL (*)(::D2WinEditBox*))Draw;
 *     …
 *     pfnDraw = (code*)(BOOL (__stdcall *)(::D2WinEditBox*))Push;
 *
 * There is no single type for that slot; `auto` would pick one of them and be
 * wrong about the rest. So a local with more than one assignment source, or one
 * whose source is a cast, a literal or anything but a name, keeps `code *` and
 * keeps failing — the disagreement is real and belongs in Ghidra's type for the
 * variable, not in a spelling here.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode,
  AssignExpr,
  Expression,
  Identifier,
  ParenExpr,
  PointerType,
  QualifiedId,
  TypedefType,
  VariableDecl,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { createKindTransformer, type Transformer } from '../../transformer.js';
import { createPlugin } from '../registry.js';
import type { TransformPlugin, PluginOptions } from '../types.js';

function unwrapParens(expr: Expression): Expression {
  while (expr.kind === NodeKind.ParenExpr) expr = (expr as ParenExpr).expression;
  return expr;
}

/** Is this the type `code *` exactly — one pointer level over Ghidra's `code`? */
function isCodePointer(type: ASTNode | null | undefined): boolean {
  if (!type || type.kind !== NodeKind.PointerType) return false;
  const pointee = (type as PointerType).pointee;
  if (pointee.kind !== NodeKind.TypedefType) return false;
  const name = (pointee as TypedefType).name;
  return name.kind === NodeKind.Identifier && (name as Identifier).name === 'code';
}

/**
 * The name an expression IS, when it is nothing but a name. `null` for a cast, a
 * literal, a call — anything whose type the declaration cannot simply adopt.
 */
function plainName(expr: Expression | null | undefined): string | null {
  if (!expr) return null;
  const e = unwrapParens(expr);
  if (e.kind === NodeKind.Identifier) return (e as Identifier).name;
  if (e.kind === NodeKind.QualifiedId) {
    const q = e as QualifiedId;
    if (q.name.kind !== NodeKind.Identifier) return null;
    const parts: string[] = [];
    for (const seg of q.qualifier) {
      if (seg.kind !== NodeKind.Identifier) return null;
      parts.push((seg as Identifier).name);
    }
    parts.push((q.name as Identifier).name);
    return (q.isGlobal ? '::' : '') + parts.join('::');
  }
  return null;
}

/** `auto`, as a type node. */
function autoType(from: ASTNode): TypedefType {
  const at = { location: from.location, leadingTrivia: [], trailingTrivia: [] };
  return {
    kind: NodeKind.TypedefType,
    name: { kind: NodeKind.Identifier, name: 'auto', ...at } as Identifier,
    ...at,
  } as TypedefType;
}

/**
 * Every name assigned to `variable` anywhere under `root`, by `=`. A compound
 * assignment (`|=`) is not a source of a type, and its presence means the slot
 * is being used as a number — so it disqualifies the variable outright.
 */
function assignedNames(root: ASTNode, variable: string): { names: Set<string>; disqualified: boolean } {
  const names = new Set<string>();
  let disqualified = false;
  for (const node of traverseAST(root)) {
    if (node.kind !== NodeKind.AssignExpr) continue;
    const assign = node as AssignExpr;
    const target = unwrapParens(assign.left);
    if (target.kind !== NodeKind.Identifier) continue;
    if ((target as Identifier).name !== variable) continue;
    if (assign.operator !== '=') { disqualified = true; continue; }
    const name = plainName(assign.right);
    if (name === null) disqualified = true;
    else names.add(name);
  }
  return { names, disqualified };
}

function createCodePointerLocalTypeTransformer(): Transformer {
  return (root: ASTNode) =>
    createKindTransformer(NodeKind.VariableDecl, (node) => {
      const decl = node as VariableDecl;
      if (!isCodePointer(decl.type)) return undefined;

      const initName = plainName(decl.initializer as Expression | null);
      if (initName === null) return undefined;

      const { names, disqualified } = assignedNames(root, decl.name.name);
      if (disqualified) return undefined;
      for (const n of names) if (n !== initName) return undefined;

      return { ...decl, type: autoType(decl.type) } as VariableDecl;
    })(root);
}

export const codePointerLocalTypePlugin: TransformPlugin = createPlugin(
  'code-pointer-local-type',
  'Code-Pointer Local Type',
  'Gives a `code *` local the type of the single function its own body assigns to it',
  () => createCodePointerLocalTypeTransformer(),
  {
    // Late: after the cast passes have settled what the assignments look like,
    // so a slot that really is reused still shows its casts and stays refused.
    priority: 560,
    tags: ['types', 'declarations'],
  },
);

export type { PluginOptions };

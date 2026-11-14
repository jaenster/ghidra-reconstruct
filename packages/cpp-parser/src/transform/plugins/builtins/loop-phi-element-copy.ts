/**
 * Loop Phi Element Copy Plugin
 *
 * VC8 rotates a scan loop so that its entry guard reads the first element of a stack array
 * directly and its bottom test reads through the pointer. COMCALLBACK_DetectCDKeyInMessage
 * (00449920):
 *
 *   449940  CMP byte ptr [EBP-0x24],CL     ; abKeyBuf[0] != 0, the entry guard
 *   ...
 *   44996c  CMP byte ptr [EAX],0           ; *pbScan != 0, the bottom test
 *
 * The decompiler merges the loop-carried value with the array's stack byte and prints the
 * phi copy as a store into the array:
 *
 *   while (abKeyBuf[0] != 0) {
 *     byChar = *pbScan;
 *     pbScan = pbScan + 1;
 *     if (0x17 < gaBnetCdKeyCharDecodeTable[byChar]) return 0;
 *     abKeyBuf[0] = *pbScan;                     <- no instruction stores this
 *   }
 *   COMCALLBACK_RemoveUserFromList((char *)abKeyBuf, &nChecksum);
 *
 * Compiled, that store zeroes abKeyBuf[0] at loop exit and the key the call reads is empty.
 * The value goes into a local of the element type instead, and the array keeps the bytes the
 * original left in it:
 *
 *   byNext = abKeyBuf[0];
 *   while (byNext != 0) { ...; byNext = *pbScan; }
 *
 * This removes a store from the program, so it is done only on proof that the original
 * never made it: the access-order store fact for the copy's `=` names no store instruction
 * (`at` null) and the instruction behind the op writes nothing (`width` 0, recorded, not
 * absent), and the value is no call. Further required, for `while (C) { ... A[k] = E; ... }`:
 *  - A is an array the function declares as a non-static local, declared once and not a
 *    parameter's name; k is a constant;
 *  - C reads A[k], has no call and no write; the copy is a statement directly in the body,
 *    alone on its line, and the only one there writing A[k];
 *  - nothing else in the loop names A[k] (`A[k]` or, for k 0, `*A`): those would be the
 *    merged value too. Reads of A at other or computed indices and of its address stay
 *    reads of memory, which no store in the loop now changes, as in the original.
 * The guard's first test reads A[k] from memory and later tests read the carried value;
 * the local is loaded from A[k] right before the loop and then carries it, so every test
 * sees the value the original tested. Without the facts nothing changes.
 * (INI_ParseCommandLineArg 00405710 prints the same merge with the copy first in the body.)
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AnyNode, ArrayType, AssignExpr, CompoundStmt, DeclStmt, ExprStmt, Expression, FunctionDecl,
  Identifier, IntegerLiteralExpr, ParameterDecl, ParenExpr, Statement, SubscriptExpr, TypeNode, UnaryExpr,
  VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { traverseAST } from '../../../ast/visitor.js';
import { Decl, Expr, Stmt } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, cloneNode, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { effectsOf, placed, type AccessOrderEvidence } from './access-order-evidence.js';

export interface LoopPhiElementCopyOptions extends PluginOptions {
  /** The original's stores per line (access-order-evidence.ts); absent, nothing changes. */
  accessOrder?: AccessOrderEvidence;
}

function unwrap(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}

/** `A[k]` with A a name and k a non-negative integer literal, or `*A` as `A[0]`. */
function elementOf(e: Expression): { array: string; index: number } | null {
  const u = unwrap(e);
  if (u.kind === NodeKind.SubscriptExpr) {
    const s = u as SubscriptExpr;
    const a = unwrap(s.array), i = unwrap(s.index);
    if (a.kind !== NodeKind.Identifier || i.kind !== NodeKind.IntegerLiteral) return null;
    return { array: (a as Identifier).name, index: Number((i as IntegerLiteralExpr).value) };
  }
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '*') {
    const a = unwrap((u as UnaryExpr).operand);
    if (a.kind === NodeKind.Identifier) return { array: (a as Identifier).name, index: 0 };
  }
  return null;
}

const sameElement = (e: Expression, array: string, index: number): boolean => {
  const m = elementOf(e);
  return !!m && m.array === array && m.index === index;
};

/** Every `A[k]` / `*A` naming the element under `n`. */
function elementUses(n: ASTNode, array: string, index: number): Expression[] {
  const out: Expression[] = [];
  for (const x of traverseAST(n)) {
    if ((x.kind === NodeKind.SubscriptExpr || x.kind === NodeKind.UnaryExpr) && sameElement(x as Expression, array, index)) {
      out.push(x as Expression);
    }
  }
  return out;
}

/** `e` with each use of the element replaced by `name`. */
function substitute(e: Expression, array: string, index: number, name: string): Expression {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if ((node.kind === NodeKind.SubscriptExpr || node.kind === NodeKind.UnaryExpr) && sameElement(node as Expression, array, index)) {
        return { ...Expr.identifier(name), location: node.location };
      }
      return undefined;
    },
  })(e) as Expression;
}

/** Hungarian prefix for a one-element local of the array's element type. */
function prefixFor(t: TypeNode): string {
  const s = emit(t as unknown as AnyNode).replace(/\s+/g, ' ').trim();
  if (/^(byte|BYTE|uchar|unsigned char|uint8_t|undefined1)$/.test(s)) return 'by';
  if (/^(char|CHAR|signed char|int8_t)$/.test(s)) return 'c';
  if (/^(wchar_t|WCHAR)$/.test(s)) return 'wc';
  if (/^(ushort|unsigned short|uint16_t|WORD|undefined2)$/.test(s)) return 'w';
  return 'n';
}

interface Scope {
  ev: AccessOrderEvidence;
  /** Local arrays declared once: name -> element type. */
  arrays: Map<string, TypeNode>;
  /** Every name the function uses, so a fresh one does not collide. */
  names: Set<string>;
  /** Placed statements per line. */
  owners: Map<number, number>;
  decls: VariableDecl[];
}

function localArrays(fn: FunctionDecl): Map<string, TypeNode> {
  const out = new Map<string, TypeNode>();
  const seen = new Map<string, number>();
  const params = new Set((fn.parameters as ParameterDecl[]).map((p) => p.name?.name).filter(Boolean) as string[]);
  for (const x of traverseAST(fn.body!)) {
    if (x.kind !== NodeKind.VariableDecl) continue;
    const v = x as VariableDecl;
    seen.set(v.name.name, (seen.get(v.name.name) ?? 0) + 1);
    if (v.type.kind !== NodeKind.ArrayType || v.specifiers.includes('static') || v.specifiers.includes('extern')) continue;
    const elem = (v.type as ArrayType).elementType;
    if (elem.kind === NodeKind.ArrayType) continue;
    out.set(v.name.name, elem);
  }
  for (const name of [...out.keys()]) if (seen.get(name) !== 1 || params.has(name)) out.delete(name);
  return out;
}

function freshName(scope: Scope, prefix: string): string {
  for (let k = 1; ; k++) {
    const n = k === 1 ? `${prefix}Next` : `${prefix}Next${k}`;
    if (!scope.names.has(n)) { scope.names.add(n); return n; }
  }
}

/** The copy `A[k] = E;` as the only `=` on its own line, with a fact proving no store. */
function phantomCopy(s: Statement, array: string, index: number, scope: Scope): Expression | null {
  if (s.kind !== NodeKind.ExprStmt || !placed(s)) return null;
  const line = s.location.start.line;
  if (s.location.end.line !== line || scope.owners.get(line) !== 1) return null;
  const e = unwrap((s as ExprStmt).expression);
  if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') return null;
  const a = e as AssignExpr;
  if (!sameElement(a.left, array, index)) return null;
  const fx = effectsOf(a.right);
  if (fx.calls || fx.writes) return null;
  const facts = scope.ev.stores.get(line);
  if (!facts || facts.length !== 1 || facts[0].ord !== 0) return null;
  if (facts[0].at !== null || facts[0].width !== 0) return null;
  return a.right;
}

/** The rewritten statements for `loop`, or null when it is not the merge. */
function rewriteLoop(loop: WhileStmt, scope: Scope): Statement[] | null {
  if (loop.body.kind !== NodeKind.CompoundStmt) return null;
  const cond = loop.condition;
  const cfx = effectsOf(cond);
  if (cfx.calls || cfx.writes) return null;
  const targets = new Map<string, { array: string; index: number }>();
  for (const x of traverseAST(cond)) {
    if (x.kind !== NodeKind.SubscriptExpr && x.kind !== NodeKind.UnaryExpr) continue;
    const m = elementOf(x as Expression);
    if (m && scope.arrays.has(m.array)) targets.set(`${m.array}[${m.index}]`, m);
  }
  if (targets.size !== 1) return null;
  const { array, index } = [...targets.values()][0];
  const body = (loop.body as CompoundStmt).statements;
  let at = -1;
  let value: Expression | null = null;
  for (let i = 0; i < body.length; i++) {
    const v = phantomCopy(body[i], array, index, scope);
    if (!v) continue;
    if (at >= 0) return null;
    at = i;
    value = v;
  }
  if (at < 0 || !value) return null;
  // The copy's own target is the one use allowed; any other names the merged value.
  for (let i = 0; i < body.length; i++) {
    const uses = elementUses(body[i], array, index).length;
    if (uses !== (i === at ? 1 : 0)) return null;
  }

  const name = freshName(scope, prefixFor(scope.arrays.get(array)!));
  scope.decls.push(Decl.variable(name, cloneNode(scope.arrays.get(array)!)));
  const copy = body[at] as ExprStmt;
  const step: ExprStmt = {
    ...copy,
    expression: Expr.assign(Expr.identifier(name), cloneNode(value)),
  };
  const statements = body.map((s, i) => (i === at ? step : s));
  const element = elementUses(cond, array, index)[0];
  const load = Stmt.expr(Expr.assign(Expr.identifier(name), cloneNode(element)));
  const rewritten = updateNode(loop, {
    condition: substitute(cond, array, index, name),
    body: updateNode(loop.body as CompoundStmt, { statements } as Partial<CompoundStmt>),
  } as Partial<WhileStmt>);
  return [{ ...load, leadingTrivia: loop.leadingTrivia ?? [] }, { ...rewritten, leadingTrivia: [] }];
}

function rewriteBlocks(scope: Scope): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      if (node.kind !== NodeKind.CompoundStmt) return undefined;
      const block = node as CompoundStmt;
      let changed = false;
      const out: Statement[] = [];
      for (const s of block.statements) {
        const r = s.kind === NodeKind.WhileStmt ? rewriteLoop(s as WhileStmt, scope) : null;
        if (r) { out.push(...r); changed = true; } else out.push(s);
      }
      return changed ? updateNode(block, { statements: out }) : undefined;
    },
  });
}

function rewriteFunction(fn: FunctionDecl, ev: AccessOrderEvidence): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const arrays = localArrays(fn);
  if (arrays.size === 0) return undefined;
  const names = new Set<string>();
  for (const x of traverseAST(fn)) if (x.kind === NodeKind.Identifier) names.add((x as Identifier).name);
  const owners = new Map<number, number>();
  for (const x of traverseAST(fn.body)) {
    if ((x.kind === NodeKind.ExprStmt || x.kind === NodeKind.ReturnStmt || x.kind === NodeKind.DeclStmt) && placed(x)) {
      owners.set(x.location.start.line, (owners.get(x.location.start.line) ?? 0) + 1);
    }
  }
  const scope: Scope = { ev, arrays, names, owners, decls: [] };
  const body = rewriteBlocks(scope)(fn.body) as CompoundStmt;
  if (scope.decls.length === 0) return undefined;
  // Declared without an initializer beside the function's other locals, so no jump can
  // bypass an initialization; the load before the loop gives it its value.
  const stmts = body.statements;
  let lead = 0;
  while (lead < stmts.length && stmts[lead].kind === NodeKind.DeclStmt) lead++;
  const decl: DeclStmt = Stmt.declStmt(scope.decls);
  const statements = [...stmts.slice(0, lead), decl, ...stmts.slice(lead)];
  return updateNode(fn, { body: updateNode(body, { statements } as Partial<CompoundStmt>) } as Partial<FunctionDecl>);
}

function createLoopPhiElementCopyTransformer(options: LoopPhiElementCopyOptions = {}): Transformer {
  const ev = options.accessOrder;
  if (!ev || ev.stores.size === 0) return (node: ASTNode) => node;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, ev);
    },
  });
}

export const loopPhiElementCopyPlugin: TransformPlugin = {
  id: 'loop-phi-element-copy',
  name: 'Loop Phi Element Copy',
  description: 'A loop-carried value the decompiler merged into a local array element, printed as a store no instruction makes, moves into a local of the element type',
  version: '1.0.0',
  defaultEnabled: true,
  // While the loop is as printed and its lines are the decompile's: after compare-form (3)
  // and rep-string-form (4), before comma-expand (13), sunk-store-hoist (21) and the loop
  // reshaping passes (40 and later), which would see the phantom store as real.
  priority: 4.5,
  tags: ['correctness'],
  createTransformer: createLoopPhiElementCopyTransformer,
};

export { createLoopPhiElementCopyTransformer };

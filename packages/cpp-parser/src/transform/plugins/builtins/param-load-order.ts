/**
 * Param Load Order Plugin
 *
 * D2Game's AI handlers take a `D2AiParamStrc *` and copy the fields they need into locals
 * before anything else (AI_Fn1_AbyssKnight, 005fab80):
 *
 *     int bEngagedInCombat = pAiParam->bEngagedInCombat;     int nDistance = pAiParam->nDistanceToTarget;
 *     D2MonStatsTxt* pMonStats = pAiParam->pMonStats;   =>   int bEngagedInCombat = pAiParam->bEngagedInCombat;
 *     int nDistance = pAiParam->nDistanceToTarget;           D2UnitStrc* pAttacker = pAiParam->pTarget;
 *     D2UnitStrc* pAttacker = pAiParam->pTarget;             D2MonStatsTxt* pMonStats = pAiParam->pMonStats;
 *     D2AiGeneralStrc* pAiGeneral = ...->pMonsterAiGeneral;  D2AiGeneralStrc* pAiGeneral = ...->pMonsterAiGeneral;
 *
 * The decompiler prints the copies in the order of the original's load instructions. VC8
 * does not emit a run of independent loads in source order: it schedules them around the
 * prologue's register saves, so the printed order compiles to other loads (AbyssKnight: the
 * original loads +0x18 then +0x14, the printed order compiles to +0x14 then +0x18).
 *
 * The order the original wrote them in was measured, not guessed: every AI.cpp function with
 * a run of two to five copies (76 of them) was compiled with VC8 SP1 under every permutation
 * of its run and compared with 1.14d. One order of the fields reaches every match any
 * permutation reaches (13 against 8 for the printed order) and loses none: nDistanceToTarget,
 * bEngagedInCombat, pTarget, then pMonStats and pMonsterAiGeneral. Those last two appear in
 * both orders across the matches, so they keep the order they are printed in.
 *
 * Value-preserving: the run is contiguous declarations, each one variable of scalar or
 * pointer type initialised by a read of one field through the parameter (casts allowed). No
 * initialiser writes anything or names a variable the run declares, and no declaration
 * shadows the parameter, so every order of the run reads the same values into the same
 * variables. A run with a field outside the table is left alone.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, CompoundStmt, CStyleCastExpr, DeclStmt, Expression, FunctionDecl, Identifier,
  MemberExpr, ParameterDecl, ParenExpr, PointerType, QualifiedType, Statement, TypeNode, VariableDecl,
} from '../../../ast/nodes.js';
import { getChildren } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { typeNodeName } from './call-arg-cast.js';

/** Struct name -> its fields in source order, as groups; fields in one group keep their printed order. */
export type ParamLoadOrderTable = Record<string, string[][]>;

export const DEFAULT_PARAM_LOAD_ORDER: ParamLoadOrderTable = {
  D2AiParamStrc: [['nDistanceToTarget'], ['bEngagedInCombat'], ['pTarget'], ['pMonStats', 'pMonsterAiGeneral']],
};

export interface ParamLoadOrderOptions extends PluginOptions {
  table?: ParamLoadOrderTable;
  onSite?: (e: { function: string; param: string; fields: string[] }) => void;
}

const SCALAR_TYPEDEFS = new Set([
  'BOOL', 'BYTE', 'WORD', 'DWORD', 'UINT', 'INT', 'LONG', 'ULONG', 'SHORT', 'USHORT', 'size_t',
  'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t', 'int64_t', 'uint64_t',
  'intptr_t', 'uintptr_t', 'ptrdiff_t',
]);

function stripQualified(t: TypeNode): TypeNode {
  while (t.kind === NodeKind.QualifiedType) t = (t as QualifiedType).type;
  return t;
}

/** A type whose initialisation from a field read is a plain copy: a pointer or a scalar. */
function isPlainType(t: TypeNode): boolean {
  t = stripQualified(t);
  if (t.kind === NodeKind.PointerType || t.kind === NodeKind.BuiltinType) return true;
  if (t.kind === NodeKind.TypedefType) {
    const n = typeNodeName((t as unknown as { name: unknown }).name);
    return n !== undefined && SCALAR_TYPEDEFS.has(n);
  }
  return false;
}

/** The struct a `T *` parameter points to, by bare name. */
function pointeeName(t: TypeNode): string | undefined {
  t = stripQualified(t);
  if (t.kind !== NodeKind.PointerType) return undefined;
  const p = stripQualified((t as PointerType).pointee);
  if (p.kind !== NodeKind.TypedefType && p.kind !== NodeKind.ElaboratedType) return undefined;
  return typeNodeName((p as unknown as { name: unknown }).name);
}

function unwrap(e: Expression): Expression {
  for (;;) {
    if (e.kind === NodeKind.ParenExpr) { e = (e as ParenExpr).expression; continue; }
    if (e.kind === NodeKind.CStyleCastExpr && isPlainType((e as CStyleCastExpr).type)) {
      e = (e as CStyleCastExpr).expression; continue;
    }
    return e;
  }
}

/** `T v = (cast)p->f;` with T plain and p one of `params`: the parameter and field, else undefined. */
function copyOf(s: Statement, params: Map<string, Map<string, number>>): { param: string; field: string; name: string } | undefined {
  if (s.kind !== NodeKind.DeclStmt) return undefined;
  const ds = s as DeclStmt;
  if (ds.declarations.length !== 1 || ds.declarations[0].kind !== NodeKind.VariableDecl) return undefined;
  const v = ds.declarations[0] as VariableDecl;
  if (v.specifiers.length > 0 || v.directInit || !v.initializer || !isPlainType(v.type)) return undefined;
  if (v.initializer.kind === NodeKind.InitListExpr) return undefined;
  const e = unwrap(v.initializer as Expression);
  if (e.kind !== NodeKind.MemberExpr) return undefined;
  const m = e as MemberExpr;
  if (!m.isArrow || m.member.kind !== NodeKind.Identifier) return undefined;
  const obj = unwrap(m.object);
  if (obj.kind !== NodeKind.Identifier) return undefined;
  const param = (obj as Identifier).name;
  if (!params.has(param)) return undefined;
  return { param, field: (m.member as Identifier).name, name: v.name.name };
}

function reorderBlock(block: CompoundStmt, params: Map<string, Map<string, number>>,
  report: (param: string, fields: string[]) => void): boolean {
  const stmts = block.statements;
  let changed = false;
  let i = 0;
  while (i < stmts.length) {
    const first = copyOf(stmts[i], params);
    if (!first) { i++; continue; }
    const run: { stmt: Statement; field: string; name: string; at: number }[] = [];
    let j = i;
    for (; j < stmts.length; j++) {
      const c = copyOf(stmts[j], params);
      if (!c || c.param !== first.param) break;
      run.push({ stmt: stmts[j], field: c.field, name: c.name, at: j - i });
    }
    const rank = params.get(first.param)!;
    const ok = run.length >= 2
      && run.every(r => rank.has(r.field))
      && run.every(r => r.name !== first.param)
      && new Set(run.map(r => r.field)).size === run.length;
    if (ok) {
      const sorted = [...run].sort((a, b) => (rank.get(a.field)! - rank.get(b.field)!) || (a.at - b.at));
      if (sorted.some((r, k) => r !== run[k])) {
        for (let k = 0; k < sorted.length; k++) stmts[i + k] = sorted[k].stmt;
        changed = true;
        report(first.param, sorted.map(r => r.field));
      }
    }
    i = j;
  }
  return changed;
}

function rewriteFunction(fn: FunctionDecl, table: ParamLoadOrderTable,
  onSite?: ParamLoadOrderOptions['onSite']): FunctionDecl | undefined {
  if (!fn.body) return undefined;
  const params = new Map<string, Map<string, number>>();
  for (const p of fn.parameters as ParameterDecl[]) {
    if (!p.name) continue;
    const s = pointeeName(p.type);
    const groups = s !== undefined ? table[s] : undefined;
    if (!groups) continue;
    const rank = new Map<string, number>();
    groups.forEach((g, k) => g.forEach(f => rank.set(f, k)));
    params.set(p.name.name, rank);
  }
  if (params.size === 0) return undefined;
  const body = cloneNode(fn.body) as CompoundStmt;
  const fname = typeNodeName((fn as unknown as { name: unknown }).name) ?? '';
  let changed = false;
  const visit = (n: ASTNode): void => {
    if (n.kind === NodeKind.CompoundStmt) {
      if (reorderBlock(n as CompoundStmt, params, (param, fields) => onSite?.({ function: fname, param, fields }))) changed = true;
    }
    for (const k of getChildren(n)) visit(k);
  };
  visit(body);
  return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
}

function createParamLoadOrderTransformer(options: ParamLoadOrderOptions = {}): Transformer {
  const table = options.table ?? DEFAULT_PARAM_LOAD_ORDER;
  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      return rewriteFunction(node, table, options.onSite);
    },
  });
}

export const paramLoadOrderPlugin: TransformPlugin = {
  id: 'param-load-order',
  name: 'Param Load Order',
  description: 'Writes a run of field copies out of a parameter struct in the order the original source wrote them',
  version: '1.0.0',
  defaultEnabled: true,
  // On the final declarations: after decl-init-merge (60), decl-scope-sink (62) and the cast
  // passes, which may still wrap an initialiser.
  priority: 976,
  tags: ['matching'],
  createTransformer: createParamLoadOrderTransformer,
};

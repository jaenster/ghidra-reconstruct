/** Restore an original constant field write which a later OR hid in the high decompile. */
import { NodeKind } from '../../../ast/kinds.js';
import type { ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, ExprStmt, Expression, FunctionDecl, Identifier, IntegerLiteralExpr, MemberExpr, ParameterDecl, ParenExpr, QualifiedId, Statement, UnaryExpr, VariableDecl } from '../../../ast/nodes.js';
import { emit } from '../../../emit/index.js';
import { Expr, Stmt } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { PluginOptions, TransformPlugin } from '../types.js';

interface Field { name: string; offset: number; size: number; type: string; bitSize?: number }
interface Evidence {
  name: string; size: number; fieldOffset: number; value: number; at: number; finalAt: number;
  afterCall: { name: string; at: number };
  between: readonly { offset: number; size: number; at: number }[];
}
export interface NativeConstantStoreOptions extends PluginOptions {
  targetPointerSize?: number;
  targetLanguageId?: string;
  structLayouts?: Record<string, readonly Field[]>;
  aggregateSizes?: Record<string, number>;
  unionNames?: readonly string[];
  constantStores?: readonly Evidence[];
}

function unparen(e: Expression): Expression {
  while (e.kind === NodeKind.ParenExpr) e = (e as ParenExpr).expression;
  return e;
}
function assignment(s: Statement): AssignExpr | undefined {
  if (s.kind !== NodeKind.ExprStmt) return undefined;
  const e = unparen((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr ? e as AssignExpr : undefined;
}
function member(e: Expression): { object: string; name: string; arrow: boolean } | undefined {
  const n = unparen(e);
  if (n.kind !== NodeKind.MemberExpr) return undefined;
  const m = n as MemberExpr, object = unparen(m.object);
  if (object.kind !== NodeKind.Identifier || m.member.kind !== NodeKind.Identifier) return undefined;
  return { object: (object as Identifier).name, name: (m.member as Identifier).name, arrow: m.isArrow };
}
function scalarWidth(type: string): number | undefined {
  const t = type.trim().replace(/\s+/g, ' ');
  if (/^(?:int32_t|uint32_t|int|unsigned int|signed int|long|unsigned long|signed long)$/.test(t)) return 4;
  if (/^(?:int16_t|uint16_t|short|short int|unsigned short|unsigned short int|signed short)$/.test(t)) return 2;
  if (/^(?:int8_t|uint8_t|char|unsigned char|signed char)$/.test(t)) return 1;
  return undefined;
}
function literal(e: Expression): bigint | undefined {
  const n = unparen(e);
  return n.kind === NodeKind.IntegerLiteral ? (n as IntegerLiteralExpr).value : undefined;
}

function createNativeConstantStoreTransformer(options: NativeConstantStoreOptions = {}): Transformer {
  if (options.targetPointerSize !== 4 || !/^x86:LE:32:/.test(options.targetLanguageId ?? '') || !options.constantStores?.length) return (node: ASTNode) => node;
  const layouts = options.structLayouts ?? {}, sizes = options.aggregateSizes ?? {}, unions = new Set(options.unionNames ?? []);
  const field = (type: string, name: string): Field | undefined => {
    if (unions.has(type)) return undefined;
    const all = layouts[type] ?? [], matches = all.filter(f => f.name === name);
    if (matches.length !== 1) return undefined;
    const f = matches[0];
    if (f.bitSize || scalarWidth(f.type) !== f.size || f.offset < 0 || f.offset + f.size > (sizes[type] ?? 0)) return undefined;
    if (all.some(g => g !== f && g.offset < f.offset + f.size && f.offset < g.offset + g.size)) return undefined;
    return f;
  };
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body || [NodeKind.GotoStmt, NodeKind.LabelStmt, NodeKind.LambdaExpr, NodeKind.FunctionDecl].some(k => findNodesByKind(fn.body!, k).length > 0)) return undefined;
      const declarations = findNodesByKind(fn.body, NodeKind.VariableDecl) as VariableDecl[];
      const named = new Map<string, string[]>();
      for (const d of [...fn.parameters as ParameterDecl[], ...declarations]) {
        if (!d.name) continue;
        const name = d.name.name, types = named.get(name) ?? [];
        types.push(emit(d.type)); named.set(name, types);
      }
      const oneType = (name: string): string | undefined => named.get(name)?.length === 1 ? named.get(name)![0] : undefined;
      const ordinaryRead = (e: Expression): boolean => {
        const m = member(e);
        if (!m?.arrow) return false;
        const type = oneType(m.object)?.match(/^(?:::)?([A-Za-z_]\w*)\s*\*$/)?.[1];
        return !!type && !!field(type, m.name);
      };
      let body = fn.body, changed = false;
      for (const fact of options.constantStores!) {
        const type = oneType(fact.name);
        const declaration = declarations.find(d => d.name.name === fact.name);
        if (!type || !/^[A-Za-z_]\w*$/.test(type) || sizes[type] !== fact.size || !declaration || declaration.initializer) continue;
        if (!Number.isSafeInteger(fact.value) || fact.value < 1 || fact.value > 0x7fffffff || fact.between.length !== 1) continue;
        const middle = fact.between[0];
        if (!fact.afterCall || !/^[A-Za-z_]\w*$/.test(fact.afterCall.name) || named.has(fact.afterCall.name)) continue;
        if (![fact.afterCall.at, fact.at, middle.at, fact.finalAt, fact.fieldOffset, middle.offset, middle.size].every(Number.isSafeInteger) || !(0 <= fact.afterCall.at && fact.afterCall.at < fact.at && fact.at < middle.at && middle.at < fact.finalAt)) continue;
        if (options.constantStores!.filter(f => f.name === fact.name && f.fieldOffset === fact.fieldOffset).length !== 1) continue;
        const candidates: { block: CompoundStmt; index: number; last: AssignExpr }[] = [];
        let targetWrites = 0;
        const blocks = [body, ...findNodesByKind(body, NodeKind.CompoundStmt) as CompoundStmt[]];
        for (const block of new Set(blocks)) for (let i = 0; i < block.statements.length; i++) {
          const last = assignment(block.statements[i]);
          if (!last) continue;
          const a = member(last.left), fa = a && !a.arrow && a.object === fact.name ? field(type, a.name) : undefined;
          if (!fa || fa.offset !== fact.fieldOffset || fa.size !== 4) continue;
          targetWrites++;
          if (last.operator !== '=' || i < 2 || block.location.file === '<generated>') continue;
          const b = assignment(block.statements[i - 1]);
          if (!b || !['=', '|=', '&=', '^='].includes(b.operator)) continue;
          const mb = member(b.left), fb = mb && !mb.arrow && mb.object === fact.name ? field(type, mb.name) : undefined;
          if (!fb || fb.offset !== middle.offset || fb.size !== middle.size || fb.offset < fa.offset + fa.size && fa.offset < fb.offset + fb.size) continue;
          const before = block.statements[i - 2];
          const call = before.kind === NodeKind.ExprStmt ? unparen((before as ExprStmt).expression) : undefined;
          if (call?.kind !== NodeKind.CallExpr) continue;
          const c = call as CallExpr;
          const callee = c.callee.kind === NodeKind.QualifiedId ? (c.callee as QualifiedId).name : c.callee;
          if (callee.kind !== NodeKind.Identifier || (callee as Identifier).name !== fact.afterCall.name) continue;
          if (!c.arguments.some(arg => { const p = unparen(arg); return p.kind === NodeKind.UnaryExpr && (p as UnaryExpr).operator === '&' && unparen((p as UnaryExpr).operand).kind === NodeKind.Identifier && (unparen((p as UnaryExpr).operand) as Identifier).name === fact.name; })) continue;
          const rhs = unparen(last.right);
          if (rhs.kind !== NodeKind.BinaryExpr || (rhs as BinaryExpr).operator !== '|') continue;
          const or = rhs as BinaryExpr;
          const other = literal(or.left) === BigInt(fact.value) ? or.right : literal(or.right) === BigInt(fact.value) ? or.left : undefined;
          if (!other || !ordinaryRead(other) || !ordinaryRead(b.right)) continue;
          candidates.push({ block, index: i - 1, last });
        }
        if (targetWrites !== 1 || candidates.length !== 1) continue;
        const { block, index, last } = candidates[0];
        const inserted = Stmt.expr(Expr.assign(last.left, Expr.intLiteral(fact.value)));
        body = createTransformer({
          visitCompoundStmt(n: CompoundStmt): ASTNode | undefined {
            // The walker rebuilds child arrays before visiting their compound.
            if (n !== block && !(n.location.file === block.location.file &&
              n.location.start.offset === block.location.start.offset && n.location.end.offset === block.location.end.offset)) return undefined;
            return updateNode(n, { statements: [...n.statements.slice(0, index), inserted, ...n.statements.slice(index)] });
          },
        })(body) as CompoundStmt;
        changed = true;
      }
      return changed ? updateNode(fn, { body }) : undefined;
    },
  });
}

export const nativeConstantStorePlugin: TransformPlugin = {
  id: 'native-constant-store', name: 'Native Constant Store',
  description: 'Restore an evidenced constant field write before a disjoint field update and its later OR overwrite',
  version: '1.0.0', defaultEnabled: true, priority: 956,
  tags: ['matching'], createTransformer: createNativeConstantStoreTransformer,
};

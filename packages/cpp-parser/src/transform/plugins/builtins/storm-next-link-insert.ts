/** The insert-side, flattened TSLink::NextLink(offset) in Storm LinkNode. */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CompoundStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ReturnStmt, Statement,
  UnaryExpr,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { bareName, shapeOfNode, unwrapParens, type TypedefResolver } from './call-arg-cast.js';
import type { StormNextLinkOptions } from './storm-next-link.js';

const wordSigned = new Set(['int', 'long', 'intptr_t', 'ssize_t']);
const wordInteger = new Set([...wordSigned, 'unsigned int', 'unsigned long', 'uintptr_t', 'size_t', 'uint32_t', 'int32_t']);
const meta = new Set(['location', 'leadingTrivia', 'trailingTrivia', 'ghidraInfo']);
const unparen = (e: Expression): Expression => unwrapParens(e);
const uncast = (e: Expression): Expression => {
  let x = unparen(e);
  while (x.kind === NodeKind.CStyleCastExpr) x = unparen((x as CStyleCastExpr).expression);
  return x;
};
const nameOf = (e: Expression): string | null => {
  const x = unparen(e);
  return x.kind === NodeKind.Identifier ? (x as Identifier).name : null;
};
const zero = (e: Expression): boolean => {
  const x = unparen(e);
  return x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n;
};
const pure = (e: Expression): boolean => {
  for (const n of traverseAST(e)) {
    if ([NodeKind.CallExpr, NodeKind.AssignExpr, NodeKind.PostfixExpr, NodeKind.NewExpr, NodeKind.ThrowExpr].includes(n.kind)) return false;
    if (n.kind === NodeKind.UnaryExpr && ['++', '--'].includes((n as UnaryExpr).operator)) return false;
  }
  return true;
};

/** Ignore source positions and parentheses, but retain casts and every operation. */
const key = (node: unknown): string => JSON.stringify(node, function (k, v) {
  if (meta.has(k)) return undefined;
  if (typeof v === 'bigint') return `${v}n`;
  if (v && typeof v === 'object' && v.kind === NodeKind.ParenExpr) return v.expression;
  return v;
});
const same = (a: unknown, b: unknown): boolean => key(a) === key(b);

const assignment = (s: Statement): AssignExpr | null => {
  if (s.kind !== NodeKind.ExprStmt) return null;
  const e = unparen((s as ExprStmt).expression);
  return e.kind === NodeKind.AssignExpr && (e as AssignExpr).operator === '=' ? e as AssignExpr : null;
};
const oneAssignment = (s: Statement): AssignExpr | null => {
  if (s.kind !== NodeKind.CompoundStmt) return assignment(s);
  const body = (s as CompoundStmt).statements;
  return body.length === 1 ? assignment(body[0]) : null;
};
const voidReturn = (s: Statement): boolean => s.kind === NodeKind.ReturnStmt && !(s as ReturnStmt).value;

interface SlotStore { cast: CStyleCastExpr; address: Expression; value: Expression }
const slotStore = (s: Statement): SlotStore | null => {
  const a = assignment(s);
  if (!a || !pure(a.right)) return null;
  const deref = unparen(a.left);
  if (deref.kind !== NodeKind.UnaryExpr || (deref as UnaryExpr).operator !== '*') return null;
  const cast = unparen((deref as UnaryExpr).operand);
  if (cast.kind !== NodeKind.CStyleCastExpr) return null;
  return { cast: cast as CStyleCastExpr, address: unparen((cast as CStyleCastExpr).expression), value: a.right };
};

export function createStormNextLinkInsertTransformer(options: StormNextLinkOptions = {}): Transformer {
  const offsets = options.structFieldOffsets ?? {};
  const resolve: TypedefResolver = name => options.typedefTargets?.[name];
  const safeCasts = (e: Expression): boolean => {
    for (const n of traverseAST(e)) {
      if (n.kind !== NodeKind.CStyleCastExpr) continue;
      const t = shapeOfNode((n as CStyleCastExpr).type, 0, resolve);
      if (!t || (t.stars === 0 && !wordInteger.has(t.base))) return false;
    }
    return true;
  };
  const keyType = (s: string) => s.replace(/\s+/g, '').replace(/(^|[<,])::/g, '$1').replace(/([<,])_(?=\d)/g, '$1-');
  const fieldOffset = (m: MemberExpr, shapeOf: ReturnType<typeof createExprShape>): number | null => {
    if (!m.isArrow || m.member.kind !== NodeKind.Identifier) return null;
    const t = shapeOf(m.object);
    if (!t || t.stars !== 1) return null;
    const candidates = [t.base, t.base.replace(/^::/, ''), bareName(t.base)];
    const table = candidates.map(k => offsets[k]).find(Boolean)
      ?? Object.entries(offsets).find(([k]) => keyType(k) === keyType(t.base))?.[1];
    return table?.[(m.member as Identifier).name] ?? null;
  };

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const locals = localTypesOf(fn);
      const shapeOf = createExprShape(locals, {
        globalTypes: options.globalTypes ?? {}, enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {}, fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {}, resolve,
      });
      const signed = (e: Expression): boolean => {
        const n = nameOf(e);
        const t = n && locals.get(n);
        const s = t && shapeOfNode(t, 0, resolve);
        return !!s && s.stars === 0 && wordSigned.has(s.base);
      };
      const headMember = (e: Expression, offset: number): MemberExpr | null => {
        const x = unparen(e);
        return x.kind === NodeKind.MemberExpr && fieldOffset(x as MemberExpr, shapeOf) === offset ? x as MemberExpr : null;
      };
      const sameHead = (a: Expression, b: Expression): boolean => safeCasts(a) && safeCasts(b) && same(uncast(a), uncast(b));
      const signTest = (s: Statement, local: string): IfStmt | null => {
        if (s.kind !== NodeKind.IfStmt) return null;
        const x = s as IfStmt;
        if (x.init || x.elseBranch || x.isConstexpr) return null;
        const c = unparen(x.condition);
        if (c.kind !== NodeKind.BinaryExpr) return null;
        const b = c as BinaryExpr;
        const t = shapeOf(b.left);
        return b.operator === '<' && zero(b.right) && safeCasts(b.left) && nameOf(uncast(b.left)) === local
          && !!t && t.stars === 0 && wordSigned.has(t.base) ? x : null;
      };
      const rightOffset = (e: Expression, head: Expression): boolean => {
        if (!safeCasts(e)) return false;
        const x = uncast(e);
        if (x.kind !== NodeKind.BinaryExpr || (x as BinaryExpr).operator !== '-') return false;
        const b = x as BinaryExpr;
        if (!sameHead(b.left, head)) return false;
        const prevNext = headMember(b.right, 4);
        if (!prevNext) return false;
        const prev = headMember(prevNext.object, 0);
        return !!prev && sameHead(prev.object, head);
      };
      const match = (s: Statement[], i: number): Statement[] | null => {
        if (i + 6 >= s.length) return null;
        const off = assignment(s[i]), next = assignment(s[i + 1]);
        const offName = off && nameOf(off.left), nextName = next && nameOf(next.left);
        if (!off || !next || !offName || !nextName || offName === nextName
          || !locals.has(offName) || !signed(next!.left) || !pure(off.right) || !pure(next.right)) return null;
        const removedLocals = new Set([offName, nextName]);
        const readsRemoved = (e: Expression): boolean => {
          const visit = (n: ASTNode): boolean => {
            if (n.kind === NodeKind.Identifier) return removedLocals.has((n as Identifier).name);
            // A field name is not a read of an equally named local.
            if (n.kind === NodeKind.MemberExpr) return visit((n as MemberExpr).object);
            return getChildren(n).some(visit);
          };
          return visit(e);
        };
        // Their assignments disappear. Every surviving expression must read its inputs
        // independently of these locals, including the helper's head and offset inputs.
        if (readsRemoved(off.right) || readsRemoved(next.right)) return null;
        const nextRead = headMember(next.right, 4);
        if (!nextRead) return null;
        const head = nextRead.object;
        const first = signTest(s[i + 2], nextName);
        if (!first || first.thenBranch.kind !== NodeKind.CompoundStmt) return null;
        const neg = (first.thenBranch as CompoundStmt).statements;
        if (neg.length !== 3 || !voidReturn(neg[2])) return null;
        const negStore = slotStore(neg[0]), negUpdate = assignment(neg[1]);
        if (!negStore || !negUpdate || !same(negUpdate.left, next.right) || !pure(negUpdate.right)) return null;
        if (readsRemoved(negStore.value) || readsRemoved(negUpdate.left) || readsRemoved(negUpdate.right)) return null;
        const negAddr = uncast(negStore.address);
        if (!safeCasts(negStore.address) || negAddr.kind !== NodeKind.UnaryExpr || (negAddr as UnaryExpr).operator !== '~'
          || nameOf((negAddr as UnaryExpr).operand) !== nextName) return null;
        const second = signTest(s[i + 3], offName);
        if (!second) return null;
        const revised = oneAssignment(second.thenBranch);
        if (!revised || nameOf(revised.left) !== offName || !rightOffset(revised.right, head)) return null;
        const posStore = slotStore(s[i + 4]), posUpdate = assignment(s[i + 5]);
        if (!posStore || !posUpdate || !voidReturn(s[i + 6])) return null;
        if (!same(posStore.cast.type, negStore.cast.type) || !same(posStore.value, negStore.value)
          || !same(posUpdate.left, negUpdate.left) || !same(posUpdate.right, negUpdate.right)) return null;
        const posAddr = uncast(posStore.address);
        if (!safeCasts(posStore.address)) return null;
        if (posAddr.kind !== NodeKind.BinaryExpr || (posAddr as BinaryExpr).operator !== '+') return null;
        const sum = posAddr as BinaryExpr;
        if (!((nameOf(uncast(sum.left)) === nextName && nameOf(uncast(sum.right)) === offName)
          || (nameOf(uncast(sum.right)) === nextName && nameOf(uncast(sum.left)) === offName))) return null;
        // There are no intervening effects: the exact seven-statement span only reads pure
        // inputs before each store. The helper's reads happen at the same point as those reads.
        const offShape = shapeOf(off.right);
        const offLocal = shapeOfNode(locals.get(offName)!, 0, resolve);
        if ((!offShape && (!offLocal || offLocal.stars !== 0 || !wordSigned.has(offLocal.base)))
          || (offShape && offShape.stars === 0 && !wordInteger.has(offShape.base))) return null;
        const arg = offShape?.stars ? Expr.cast(Type.typedef('intptr_t'), cloneNode(off.right)) : cloneNode(off.right);
        const helper = Expr.call('D2_StormNextLink', [cloneNode(head), arg]);
        const store = Expr.assign(Expr.unary('*', Expr.cast(cloneNode(negStore.cast.type), helper)), cloneNode(negStore.value));
        const stmt = updateNode(neg[0] as ExprStmt, { expression: store } as Partial<ExprStmt>);
        return [stmt, neg[1], neg[2]];
      };

      const replacements = new Map<CompoundStmt, CompoundStmt>();
      for (const node of traverseAST(fn.body)) {
        if (node.kind !== NodeKind.CompoundStmt) continue;
        const c = node as CompoundStmt;
        const out: Statement[] = [];
        let changed = false;
        for (let i = 0; i < c.statements.length;) {
          const replacement = match(c.statements, i);
          if (replacement) { out.push(...replacement); i += 7; changed = true; }
          else out.push(c.statements[i++]);
        }
        if (changed) replacements.set(c, updateNode(c, { statements: out } as Partial<CompoundStmt>));
      }
      if (!replacements.size) return undefined;
      const rebuild = (n: unknown): unknown => {
        if (Array.isArray(n)) {
          const items = n.map(rebuild);
          return items.some((x, i) => x !== n[i]) ? items : n;
        }
        if (!n || typeof n !== 'object' || !('kind' in n)) return n;
        const hit = replacements.get(n as CompoundStmt);
        if (hit) return hit;
        let copy: Record<string, unknown> | null = null;
        for (const [k, v] of Object.entries(n as Record<string, unknown>)) {
          if (meta.has(k) || !v || typeof v !== 'object') continue;
          const x = rebuild(v);
          if (x !== v) { copy ??= { ...(n as Record<string, unknown>) }; copy[k] = x; }
        }
        return copy ?? n;
      };
      const body = rebuild(fn.body) as CompoundStmt;
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

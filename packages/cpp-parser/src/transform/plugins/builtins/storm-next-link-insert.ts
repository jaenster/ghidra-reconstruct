/** The insert-side, flattened TSLink::NextLink(offset) in Storm LinkNode. */
import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CStyleCastExpr, CompoundStmt, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, IfStmt, IntegerLiteralExpr, MemberExpr, ReturnStmt, Statement, SubscriptExpr,
  UnaryExpr, VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Type } from '../../../ast/factory.js';
import { emit } from '../../../emit/index.js';
import { getChildren, traverseAST } from '../../../ast/visitor.js';
import { createTransformer, updateNode, cloneNode, type Transformer } from '../../transformer.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';
import { bareName, shapeOfNode, shapeOfSpelling, unwrapParens, type TypeShape, type TypedefResolver } from './call-arg-cast.js';
import type { StormNextLinkOptions } from './storm-next-link.js';

const wordSigned = new Set(['int', 'long', 'intptr_t', 'ssize_t']);
const wordInteger = new Set([...wordSigned, 'unsigned int', 'unsigned long', 'uint', 'uintptr_t', 'size_t', 'uint32_t', 'int32_t']);
/** Pointee types one byte wide: adding an integer to such a pointer adds that many bytes. */
const byteBase = new Set(['char', 'signed char', 'unsigned char', 'uchar', 'uint8_t', 'int8_t', 'byte', 'BYTE', 'undefined1']);
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
  const castsAreWords = (e: Expression): boolean => {
    for (const n of traverseAST(e)) {
      if (n.kind !== NodeKind.CStyleCastExpr) continue;
      const t = shapeOfNode((n as CStyleCastExpr).type, 0, resolve);
      if (!t || (t.stars === 0 && !wordInteger.has(t.base))) return false;
    }
    return true;
  };
  const keyType = (s: string) => s.replace(/\s+/g, '').replace(/(^|[<,])::/g, '$1').replace(/([<,])_(?=\d)/g, '$1-');
  // A struct table keyed by Ghidra's spelling of a template name (no space after a comma, no
  // leading `::`), found from the parser's spelling.
  const tableOf = <V>(tables: Record<string, Record<string, V>>, base: string): Record<string, V> | undefined =>
    [base, base.replace(/^::/, ''), bareName(base)].map(k => tables[k]).find(Boolean)
      ?? Object.entries(tables).find(([k]) => keyType(k) === keyType(base))?.[1];
  const fieldOffset = (m: MemberExpr, shapeOf: ReturnType<typeof createExprShape>): number | null => {
    if (m.member.kind !== NodeKind.Identifier) return null;
    const t = shapeOf(m.object);
    if (!t || t.stars !== (m.isArrow ? 1 : 0)) return null;
    return tableOf(offsets, t.base)?.[(m.member as Identifier).name] ?? null;
  };

  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const locals = localTypesOf(fn);
      const bindings = new Map<string, number>();
      const bind = (name: string) => bindings.set(name, (bindings.get(name) ?? 0) + 1);
      fn.parameters.forEach(p => { if (p.name) bind(p.name.name); });
      for (const n of traverseAST(fn.body)) if (n.kind === NodeKind.VariableDecl) bind((n as VariableDecl).name.name);
      const ambiguous = new Set([...bindings].filter(([, count]) => count > 1).map(([name]) => name));
      const shapeOf = createExprShape(locals, {
        globalTypes: options.globalTypes ?? {}, enclosingVarTypes: options.enclosingVarTypes ?? {},
        structFields: options.structFields ?? {}, fieldTypes: options.fieldTypes ?? {},
        returnTypes: options.functionReturnTypes ?? {}, resolve,
      });
      const operandShape = (e: Expression): TypeShape | null => {
        const t = shapeOf(e);
        if (t) return t;
        const x = unparen(e);
        if (x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value >= 0n && (x as IntegerLiteralExpr).value <= 0xffffffffn) {
          return { base: 'unsigned int', stars: 0, isConst: false };
        }
        if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
          const value = unparen((x as UnaryExpr).operand);
          if (value.kind === NodeKind.IntegerLiteral && (value as IntegerLiteralExpr).value <= 0x80000000n) {
            return { base: 'int', stars: 0, isConst: false };
          }
        }
        if (x.kind === NodeKind.BinaryExpr) {
          const b = x as BinaryExpr;
          if (b.operator !== '+' && b.operator !== '-') return null;
          const a = operandShape(b.left), c = operandShape(b.right);
          const integer = (t: TypeShape | null) => t?.stars === 0 && wordInteger.has(t.base);
          if (integer(a) && integer(c)) return { base: 'intptr_t', stars: 0, isConst: false };
          if (a?.stars === 1 && byteBase.has(a.base) && integer(c)) return a;
          if (b.operator === '+' && integer(a) && c?.stars === 1 && byteBase.has(c.base)) return c;
          return null;
        }
        if (x.kind !== NodeKind.MemberExpr) return null;
        const m = x as MemberExpr;
        if (m.member.kind !== NodeKind.Identifier) return null;
        const o = operandShape(m.object);
        if (!o || o.stars !== (m.isArrow ? 1 : 0)) return null;
        const spelling = tableOf(options.structFields ?? {}, o.base)?.[(m.member as Identifier).name];
        if (!spelling) return null;
        // shapeOfSpelling leaves template names out; a template's pointer is still its stars.
        const stars = /\**\s*$/.exec(spelling)![0].replace(/\s/g, '').length;
        return shapeOfSpelling(spelling, resolve)
          ?? (/[<>]/.test(spelling) ? { base: spelling.replace(/[\s*]*$/, '').trim(), stars, isConst: false } : null);
      };
      // NextLink adds and subtracts byte offsets. A sum or difference with a pointer operand
      // scales by the pointee size, so every such operand must point at bytes; an operand of
      // unknown type is refused.
      const byteSums = (e: Expression): boolean => {
        for (const n of traverseAST(e)) {
          if (n.kind !== NodeKind.BinaryExpr) continue;
          const b = n as BinaryExpr;
          if (b.operator !== '+' && b.operator !== '-') continue;
          for (const side of [b.left, b.right]) {
            const t = operandShape(side);
            if (!t) return false;
            if (t.stars > 0 && !(t.stars === 1 && byteBase.has(t.base))) return false;
          }
        }
        return true;
      };
      const safeCasts = (e: Expression): boolean => castsAreWords(e) && byteSums(e);
      // Ghidra types the next word as an integer or a pointer. Its sign test
      // must read it as a signed word (signTest); a pointer is only used as an
      // address value, never as a scaled non-byte operand in the sum.
      const word = (e: Expression): boolean => {
        const n = nameOf(e);
        const t = n && locals.get(n);
        const s = t && shapeOfNode(t, 0, resolve);
        return !!s && (s.stars > 0 || wordInteger.has(s.base));
      };
      const wordElement = (e: Expression): boolean => {
        const t = operandShape(e);
        return !!t && (t.stars > 1 || (t.stars === 1 && wordInteger.has(t.base)));
      };
      /** A read at offset 0 or 4: members, or arrays of pointers/32-bit words. */
      const headOfRead = (e: Expression, offset: number): Expression | null => {
        if (!safeCasts(e)) return null;
        const x = uncast(e);
        if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*' && offset === 0) {
          const pointer = (x as UnaryExpr).operand;
          return wordElement(pointer) ? pointer : null;
        }
        if (x.kind === NodeKind.SubscriptExpr) {
          const s = x as SubscriptExpr, i = unparen(s.index);
          return wordElement(s.array) && i.kind === NodeKind.IntegerLiteral && (i as IntegerLiteralExpr).value * 4n === BigInt(offset) ? s.array : null;
        }
        if (x.kind !== NodeKind.MemberExpr || fieldOffset(x as MemberExpr, operandShape) !== offset) return null;
        const m = x as MemberExpr;
        // `entry->link.next` reads the next word of the embedded link, whose
        // address (not the containing entry's) is the helper's receiver.
        return m.isArrow ? m.object : Expr.unary('&', cloneNode(m.object));
      };
      const addressBase = (e: Expression): Expression => {
        const x = uncast(e);
        if (x.kind !== NodeKind.UnaryExpr || (x as UnaryExpr).operator !== '&') return x;
        const m = unparen((x as UnaryExpr).operand);
        if (m.kind !== NodeKind.MemberExpr || fieldOffset(m as MemberExpr, operandShape) !== 0) return x;
        return addressBase((m as MemberExpr).isArrow ? (m as MemberExpr).object : Expr.unary('&', (m as MemberExpr).object));
      };
      const sameHead = (a: Expression, b: Expression): boolean => safeCasts(a) && safeCasts(b) && same(addressBase(a), addressBase(b));
      const volatileType = (spelling: string, seen = new Set<string>()): boolean => {
        if (/\bvolatile\b/.test(spelling)) return true;
        const base = spelling.replace(/\[[^\]]*\]/g, '').replace(/\bconst\b|\*/g, '').replace(/\s+/g, ' ').trim();
        const target = options.typedefTargets?.[base];
        if (!target) return false;
        if (seen.has(base)) return true;
        seen.add(base);
        return volatileType(target, seen);
      };
      const volatileRead = (root: ASTNode): boolean => {
        for (const n of traverseAST(root)) {
          if (n.kind === NodeKind.Identifier) {
            const name = (n as Identifier).name, type = locals.get(name);
            if (volatileType(type ? emit(type) : options.globalTypes?.[name] ?? '')) return true;
          }
          if (n.kind === NodeKind.MemberExpr) {
            const m = n as MemberExpr, t = operandShape(m.object);
            if (t && m.member.kind === NodeKind.Identifier
              && volatileType(tableOf(options.structFields ?? {}, t.base)?.[(m.member as Identifier).name] ?? '')) return true;
          }
        }
        return false;
      };
      // Reduce only byte-address sums. In CMDDEF, `next->szName + off - 16`
      // is `next + off`: szName is an inline char[16] at offset 16. A pointer
      // field would READ a different address, so it must never use this rule.
      const slotSum = (e: Expression, next: string, off: string): boolean => {
        type Sum = [bigint, bigint, bigint];
        const sum = (e: Expression): Sum | null => {
          const x = uncast(e), name = nameOf(x);
          if (name === next) return [1n, 0n, 0n];
          if (name === off) return [0n, 1n, 0n];
          if (x.kind === NodeKind.IntegerLiteral) return [0n, 0n, (x as IntegerLiteralExpr).value];
          if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '-') {
            const value = sum((x as UnaryExpr).operand);
            return value && value.every((n, i) => i === 2 || n === 0n) ? [0n, 0n, -value[2]] : null;
          }
          if (x.kind === NodeKind.BinaryExpr) {
            const b = x as BinaryExpr;
            if (b.operator !== '+' && b.operator !== '-') return null;
            const a = sum(b.left), c = sum(b.right), sign = b.operator === '+' ? 1n : -1n;
            return a && c ? [a[0] + sign * c[0], a[1] + sign * c[1], a[2] + sign * c[2]] : null;
          }
          if (x.kind !== NodeKind.MemberExpr) return null;
          const m = x as MemberExpr, t = operandShape(m.object);
          if (!m.isArrow || nameOf(uncast(m.object)) !== next || !t || m.member.kind !== NodeKind.Identifier) return null;
          const field = tableOf(options.structFields ?? {}, t.base)?.[(m.member as Identifier).name];
          const array = field && /^\s*(.*?)\s*\[\s*(\d+)\s*\]\s*$/.exec(field);
          const element = array && shapeOfSpelling(array[1], resolve), at = fieldOffset(m, operandShape);
          const size = options.aggregateSizes?.[t.base];
          if (!array || !element || element.stars !== 0 || !byteBase.has(element.base) || at === null || !Number.isSafeInteger(at) || at < 0
            || size === undefined || Number(array[2]) <= 0 || at + Number(array[2]) > size) return null;
          return [1n, 0n, BigInt(at)];
        };
        if (!safeCasts(e) || volatileRead(e)) return false;
        const value = sum(e);
        return !!value && value[0] === 1n && value[1] === 1n && value[2] === 0n;
      };
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
        const prevNext = headOfRead(b.right, 4);
        if (!prevNext) return false;
        const prev = headOfRead(prevNext, 0);
        return !!prev && sameHead(prev, head);
      };
      const match = (s: Statement[], i: number): Statement[] | null => {
        if (i + 6 >= s.length) return null;
        const off = assignment(s[i]), next = assignment(s[i + 1]);
        const offName = off && nameOf(off.left), nextName = next && nameOf(next.left);
        if (!off || !next || !offName || !nextName || offName === nextName
          || !locals.has(offName) || !word(next!.left) || !pure(off.right) || !pure(next.right)) return null;
        if (s.slice(i, i + 7).some(st => [...traverseAST(st)].some(n => n.kind === NodeKind.Identifier && ambiguous.has((n as Identifier).name)))) return null;
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
        const head = headOfRead(next.right, 4);
        if (!head) return null;
        const first = signTest(s[i + 2], nextName);
        if (!first || first.thenBranch.kind !== NodeKind.CompoundStmt) return null;
        const neg = (first.thenBranch as CompoundStmt).statements;
        if (neg.length !== 3 || !voidReturn(neg[2])) return null;
        const negStore = slotStore(neg[0]), negUpdate = assignment(neg[1]);
        if (!negStore || !negUpdate || !same(negUpdate.left, next.right) || !pure(negUpdate.right)) return null;
        if (readsRemoved(negStore.value) || readsRemoved(negUpdate.left) || readsRemoved(negUpdate.right)) return null;
        const negAddr = uncast(negStore.address);
        if (!safeCasts(negStore.address) || negAddr.kind !== NodeKind.UnaryExpr || (negAddr as UnaryExpr).operator !== '~'
          || nameOf(uncast((negAddr as UnaryExpr).operand)) !== nextName) return null;
        const second = signTest(s[i + 3], offName);
        if (!second) return null;
        const revised = oneAssignment(second.thenBranch);
        if (!revised || nameOf(revised.left) !== offName || !rightOffset(revised.right, head)) return null;
        const posStore = slotStore(s[i + 4]), posUpdate = assignment(s[i + 5]);
        if (!posStore || !posUpdate || !voidReturn(s[i + 6])) return null;
        if (!same(posStore.cast.type, negStore.cast.type) || !same(posStore.value, negStore.value)
          || !same(posUpdate.left, negUpdate.left) || !same(posUpdate.right, negUpdate.right)) return null;
        if (!slotSum(posStore.address, nextName, offName) || s.slice(i, i + 7).some(volatileRead)) return null;
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
        removed.add(offName).add(nextName);
        return [stmt, neg[1], neg[2]];
      };

      const removed = new Set<string>();
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
      let body = rebuild(fn.body) as CompoundStmt;

      // A removed local nothing reads or writes any more loses its bare declaration too.
      const notUses = new Set<ASTNode>();
      for (const n of traverseAST(body)) {
        if (n.kind === NodeKind.VariableDecl) notUses.add((n as VariableDecl).name);
        // A field name is not a use of an equally named local.
        if (n.kind === NodeKind.MemberExpr) notUses.add((n as MemberExpr).member);
      }
      const used = new Set<string>();
      for (const n of traverseAST(body)) {
        if (n.kind === NodeKind.Identifier && !notUses.has(n)) used.add((n as Identifier).name);
      }
      const dead = (st: Statement): boolean => {
        if (st.kind !== NodeKind.DeclStmt) return false;
        const ds = (st as DeclStmt).declarations;
        if (ds.length !== 1 || ds[0].kind !== NodeKind.VariableDecl) return false;
        const v = ds[0] as VariableDecl;
        return removed.has(v.name.name) && !used.has(v.name.name) && !v.initializer;
      };
      const prune = (c: CompoundStmt): CompoundStmt => {
        let changed = false;
        const out: Statement[] = [];
        for (const st of c.statements) {
          if (dead(st)) { changed = true; continue; }
          out.push(st);
        }
        return changed ? updateNode(c, { statements: out } as Partial<CompoundStmt>) : c;
      };
      replacements.clear();
      for (const n of traverseAST(body)) {
        if (n.kind !== NodeKind.CompoundStmt) continue;
        const p = prune(n as CompoundStmt);
        if (p !== n) replacements.set(n as CompoundStmt, p);
      }
      if (replacements.size) body = rebuild(body) as CompoundStmt;
      return updateNode(fn, { body } as Partial<FunctionDecl>);
    },
  });
}

/**
 * Byte arithmetic on a pointer whose pointee has no size.
 *
 * Ghidra types a byte offset onto a buffer as `pBuf + n` whatever the declared
 * pointee, and where that pointee is `void` (or the pointer is a function
 * pointer) GCC takes it as an extension: the pointee counts as one byte, so
 * `p + n` moves n bytes. ISO C++ rejects both ("pointer of type 'void *' used
 * in arithmetic", MSVC C2036 / C2296 / C2171), so the original MSVC source can
 * not have spelled it that way, and a strict compiler other than GCC does not
 * build the function at all.
 *
 * The rewrite does the same arithmetic on `uint8_t *` and converts back:
 *
 *   p + n        ->  (T)((uint8_t *)p + n)     T = p's own type
 *   n + p        ->  (T)(n + (uint8_t *)p)
 *   p - n        ->  (T)((uint8_t *)p - n)
 *   p - q        ->  (uint8_t *)p - (uint8_t *)q          a byte distance
 *   p += n, ++p  ->  p = (T)((uint8_t *)p + n)            p free of side effects
 *   p++;         ->  p = (T)((uint8_t *)p + 1);           only where the value is discarded
 *
 * Every form is value-preserving: GCC's extension IS byte arithmetic, and the
 * conversion back to T keeps the expression's type, so overloads, conditionals
 * and the assignment it feeds see exactly what they saw before. Where the sum
 * is already the operand of a cast to an integer or object pointer type, the
 * `(T)` is not written: `(int *)((uint8_t *)p + 4)` is the same conversion.
 * A chain (`p + a - b`) is folded onto one byte expression rather than cast
 * back and forth at every step.
 *
 * A postfix increment whose value is used is left alone: `p++` as a value is
 * the OLD p, which an assignment cannot spell without a temporary, and the
 * error stays visible rather than being papered over.
 */

import { NodeKind } from '../../../ast/kinds.js';
import type {
  ASTNode, FunctionDecl, VariableDecl, ParameterDecl, Expression, BinaryExpr, TypeNode,
  UnaryExpr, PostfixExpr, AssignExpr, CStyleCastExpr, ExprStmt, ForStmt, PointerType,
  QualifiedType, BuiltinType, TypedefType, MemberExpr, SubscriptExpr,
} from '../../../ast/nodes.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import { Type, Expr } from '../../../ast/factory.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createExprShape } from './expr-shape.js';
import { typeNodeName, unwrapParens, type TypedefResolver } from './call-arg-cast.js';

export interface SizelessPointerArithOptions extends PluginOptions {
  globalTypes?: Record<string, string>;
  enclosingVarTypes?: Record<string, string>;
  fieldTypes?: Record<string, string>;
  structFields?: Record<string, Record<string, string>>;
  functionReturnTypes?: Record<string, string>;
  typedefTargets?: Record<string, string>;
  /** Typedef names that stand for a function pointer. */
  funcdefNames?: string[];
  /** Typedef names a same-named namespace hides, spelled `::Name`. */
  rootQualifiedTypedefs?: string[];
}

/**
 * Platform typedefs for `void *` that no Ghidra typedef table carries: a
 * HANDLE plus an offset is the same extension as a `void *` plus one.
 */
const VOID_POINTER_TYPEDEFS = new Set(['LPVOID', 'PVOID', 'LPCVOID', 'HANDLE']);

const byteType = (): TypeNode => Type.pointer(Type.typedef('uint8_t'));

/** True for a type with no element size: `void *` (any cv) or a function pointer. */
function isSizelessNode(t: TypeNode, funcdefs: ReadonlySet<string>, resolve: TypedefResolver, depth = 0): boolean {
  if (depth > 8) return false;
  switch (t.kind) {
    case NodeKind.QualifiedType:
      return isSizelessNode((t as QualifiedType).type, funcdefs, resolve, depth + 1);
    case NodeKind.PointerType: {
      let p = (t as PointerType).pointee;
      while (p.kind === NodeKind.QualifiedType) p = (p as QualifiedType).type;
      if (p.kind === NodeKind.FunctionType) return true;
      if (p.kind === NodeKind.BuiltinType) return (p as BuiltinType).name === 'void';
      return false;
    }
    case NodeKind.TypedefType: {
      const n = typeNodeName((t as TypedefType).name);
      if (n === undefined) return false;
      if (funcdefs.has(n) || VOID_POINTER_TYPEDEFS.has(n)) return true;
      const under = resolve(n);
      return under !== undefined && /^\s*(const\s+)?void\s*\*\s*$/.test(under);
    }
    default:
      return false;
  }
}

/** No call, assignment or increment anywhere: safe to read twice. */
function isPure(e: Expression): boolean {
  const u = unwrapParens(e);
  switch (u.kind) {
    case NodeKind.Identifier:
    case NodeKind.QualifiedId:
    case NodeKind.IntegerLiteral:
      return true;
    case NodeKind.MemberExpr:
      return isPure((u as MemberExpr).object);
    case NodeKind.SubscriptExpr:
      return isPure((u as SubscriptExpr).array) && isPure((u as SubscriptExpr).index);
    case NodeKind.UnaryExpr: {
      const x = u as UnaryExpr;
      return x.operator !== '++' && x.operator !== '--' && isPure(x.operand);
    }
    case NodeKind.CStyleCastExpr:
      return isPure((u as CStyleCastExpr).expression);
    case NodeKind.BinaryExpr:
      return isPure((u as BinaryExpr).left) && isPure((u as BinaryExpr).right);
    default:
      return false;
  }
}

export function createSizelessPointerArithTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as SizelessPointerArithOptions;
  const typedefTargets = o.typedefTargets ?? {};
  const resolve: TypedefResolver = name => typedefTargets[name];
  const funcdefs = new Set(o.funcdefNames ?? []);
  const rootQualified = new Set(o.rootQualifiedTypedefs ?? []);

  return createTransformer({
    visitFunctionDecl(node: FunctionDecl): ASTNode | undefined {
      if (!node.body) return undefined;

      const localTypes = new Map<string, TypeNode>();
      for (const p of node.parameters) {
        const pd = p as ParameterDecl;
        if (pd.name) localTypes.set(pd.name.name, pd.type);
      }
      for (const d of findNodesByKind(node.body, NodeKind.VariableDecl)) {
        const v = d as VariableDecl;
        if (!localTypes.has(v.name.name)) localTypes.set(v.name.name, v.type);
      }
      const shapeOf = createExprShape(localTypes, {
        globalTypes: o.globalTypes ?? {},
        enclosingVarTypes: o.enclosingVarTypes ?? {},
        structFields: o.structFields ?? {},
        fieldTypes: o.fieldTypes ?? {},
        returnTypes: o.functionReturnTypes ?? {},
        resolve,
      });

      /** The casts this pass wrote, with the byte expression inside each. */
      const written = new WeakMap<ASTNode, { type: TypeNode; bytes: Expression }>();

      /**
       * The type to convert a byte result back to, when `e` is a sizeless
       * pointer; null otherwise. A local's own declared type is the exact
       * spelling; anything else goes through the shape tables.
       */
      function sizelessType(e: Expression): TypeNode | null {
        const u = unwrapParens(e);
        const mine = written.get(u);
        if (mine) return mine.type;
        if (u.kind === NodeKind.Identifier) {
          const local = localTypes.get((u as { name: string }).name);
          if (local) return isSizelessNode(local, funcdefs, resolve) ? local : null;
        }
        if (u.kind === NodeKind.CStyleCastExpr) {
          const t = (u as CStyleCastExpr).type;
          return isSizelessNode(t, funcdefs, resolve) ? t : null;
        }
        const s = shapeOf(e);
        if (!s) return null;
        if (s.stars === 1 && s.base === 'void') {
          const v: TypeNode = s.isConst ? Type.const(Type.void()) : Type.void();
          return Type.pointer(v);
        }
        if (s.stars === 0 && funcdefs.has(s.base)) return Type.typedefAt(s.base, rootQualified.has(s.base));
        return null;
      }

      /** `e` as a `uint8_t *` expression. */
      function bytesOf(e: Expression): Expression {
        const mine = written.get(unwrapParens(e));
        if (mine) return mine.bytes;
        return Expr.cast(byteType(), e);
      }

      /** True when `e` is certainly not a pointer (an integer, an enum, a literal). */
      function isOffset(e: Expression): boolean {
        if (sizelessType(e)) return false;
        const s = shapeOf(e);
        if (!s) {
          // Unknown shape: a non-sizeless pointer added to a sizeless one does
          // not compile under GCC either, so only an & expression is refused.
          const u = unwrapParens(e);
          return !(u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&');
        }
        return s.stars === 0 && !funcdefs.has(s.base);
      }

      /** `(T)(bytes)`, remembered so an enclosing step can fold onto it. */
      function backTo(type: TypeNode, bytes: Expression): Expression {
        const cast = Expr.cast(type, Expr.paren(bytes));
        written.set(cast, { type, bytes });
        return cast;
      }

      /** `p + n` / `n + p` / `p - n` as a byte expression, with its type; or null. */
      function byteSum(b: BinaryExpr): { type: TypeNode; bytes: Expression } | null {
        if (b.operator !== '+' && b.operator !== '-') return null;
        const lt = sizelessType(b.left);
        if (lt && isOffset(b.right)) {
          return { type: lt, bytes: Expr.binary(bytesOf(b.left), b.operator, b.right) };
        }
        if (b.operator === '+') {
          const rt = sizelessType(b.right);
          if (rt && isOffset(b.left)) {
            return { type: rt, bytes: Expr.binary(b.left, '+', bytesOf(b.right)) };
          }
        }
        return null;
      }

      /** `x += n`, `++x`, `x++;` as `x = (T)((uint8_t *)x op n)`. */
      function stepAssign(target: Expression, op: '+' | '-', amount: Expression): Expression | null {
        const t = sizelessType(target);
        if (!t || !isPure(target) || !isOffset(amount)) return null;
        return Expr.assign(target, backTo(t, Expr.binary(bytesOf(target), op, amount)));
      }

      const one = (): Expression => Expr.intLiteral(1);

      /** A postfix step whose value nobody reads. */
      function discardedStep(e: Expression | null): Expression | null {
        if (!e) return null;
        const u = unwrapParens(e);
        if (u.kind !== NodeKind.PostfixExpr) return null;
        const p = u as PostfixExpr;
        return stepAssign(p.operand, p.operator === '++' ? '+' : '-', one());
      }

      /** A cast target that takes a `uint8_t *` the same way it took the sizeless pointer. */
      function takesBytes(t: TypeNode): boolean {
        if (isSizelessNode(t, funcdefs, resolve)) return false;
        if (t.kind === NodeKind.PointerType) {
          let p = (t as PointerType).pointee;
          while (p.kind === NodeKind.QualifiedType) p = (p as QualifiedType).type;
          return p.kind !== NodeKind.FunctionType;
        }
        if (t.kind === NodeKind.BuiltinType) return (t as BuiltinType).name !== 'void';
        if (t.kind === NodeKind.TypedefType) {
          const n = typeNodeName((t as TypedefType).name);
          if (n === undefined || funcdefs.has(n)) return false;
          const s = shapeOf(Expr.cast(t, Expr.intLiteral(0)));
          return !!s && (s.stars > 0 || s.base !== 'void');
        }
        return false;
      }

      const visitBinary = (b: BinaryExpr): ASTNode | undefined => {
        if (b.operator === '-') {
          const lt = sizelessType(b.left);
          const rt = sizelessType(b.right);
          if (lt && rt) return Expr.binary(bytesOf(b.left), '-', bytesOf(b.right));
        }
        const sum = byteSum(b);
        return sum ? backTo(sum.type, sum.bytes) : undefined;
      };
      const visitCast = (c: CStyleCastExpr): ASTNode | undefined => {
        const mine = written.get(unwrapParens(c.expression));
        if (!mine || !takesBytes(c.type)) return undefined;
        return updateNode(c, { expression: Expr.paren(mine.bytes) } as Partial<CStyleCastExpr>);
      };
      const visitAssign = (a: AssignExpr): ASTNode | undefined => {
        if (a.operator !== '+=' && a.operator !== '-=') return undefined;
        return stepAssign(a.left, a.operator === '+=' ? '+' : '-', a.right) ?? undefined;
      };
      const visitPrefix = (u: UnaryExpr): ASTNode | undefined => {
        if (u.operator !== '++' && u.operator !== '--') return undefined;
        const r = stepAssign(u.operand, u.operator === '++' ? '+' : '-', one());
        return r ? Expr.paren(r) : undefined;
      };
      const visitExprStmt = (s: ExprStmt): ASTNode | undefined => {
        const r = discardedStep(s.expression);
        return r ? updateNode(s, { expression: r } as Partial<ExprStmt>) : undefined;
      };
      const visitFor = (f: ForStmt): ASTNode | undefined => {
        const r = discardedStep(f.increment);
        return r ? updateNode(f, { increment: r } as Partial<ForStmt>) : undefined;
      };

      let changed = false;
      const inner = createTransformer({
        visitNode(n: ASTNode): ASTNode | undefined {
          let r: ASTNode | undefined;
          switch (n.kind) {
            case NodeKind.BinaryExpr: r = visitBinary(n as BinaryExpr); break;
            case NodeKind.CStyleCastExpr: r = visitCast(n as CStyleCastExpr); break;
            case NodeKind.AssignExpr: r = visitAssign(n as AssignExpr); break;
            case NodeKind.UnaryExpr: r = visitPrefix(n as UnaryExpr); break;
            case NodeKind.ExprStmt: r = visitExprStmt(n as ExprStmt); break;
            case NodeKind.ForStmt: r = visitFor(n as ForStmt); break;
            default: return undefined;
          }
          if (r) changed = true;
          return r;
        },
      });

      const newBody = inner(node.body);
      if (!changed) return undefined;
      return updateNode(node, { body: newBody } as Partial<FunctionDecl>);
    },
  });
}

export const sizelessPointerArithPlugin: TransformPlugin = {
  id: 'sizeless-pointer-arith',
  name: 'Sizeless Pointer Arithmetic',
  description:
    'Spells GCC\'s void* / function-pointer arithmetic as the byte arithmetic it is, on uint8_t*, converting back to the original type',
  version: '1.0.0',
  defaultEnabled: true,
  // After the cast passes (610-625) settle every operand's type.
  priority: 626,
  tags: ['cleanup', 'type'],
  createTransformer: createSizelessPointerArithTransformer,
};

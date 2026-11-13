/**
 * Preserve VC8's sign-bit branch form for byte flags and Win32 key state.
 *
 * In a predicate, `(char)x < 0` and `x & 0x80` test the same byte bit, but
 * VC8 chooses JGE for the signed spelling and JNS for the mask. Likewise a
 * SHORT returned by GetKeyState/GetAsyncKeyState uses bit 15. Only predicate
 * positions are changed: a raw mask has value 0x80/0x8000 instead of 0/1.
 */

import { NodeKind } from '../../../ast/kinds.js';
import { Expr } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, BuiltinType, CStyleCastExpr, CallExpr, CharLiteralExpr,
  CommaExpr, ConditionalExpr, DoWhileStmt, Expression, ForStmt, FunctionDecl, Identifier,
  IfStmt, IntegerLiteralExpr, ParenExpr, PostfixExpr, TypedefType, UnaryExpr,
  VariableDecl, WhileStmt,
} from '../../../ast/nodes.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { createPlugin } from '../registry.js';
import { bareName, calleeName, unwrapParens } from './call-arg-cast.js';
import { createExprShape } from './expr-shape.js';
import { localTypesOf } from './compare-form.js';

function zero(e: Expression): boolean {
  const x = unwrapParens(e);
  return (x.kind === NodeKind.IntegerLiteral && (x as IntegerLiteralExpr).value === 0n && !(x as IntegerLiteralExpr).suffix)
    || (x.kind === NodeKind.CharLiteral && (x as CharLiteralExpr).value === 0 && !(x as CharLiteralExpr).prefix);
}

function shortType(d: VariableDecl): boolean {
  const t = d.type;
  if (t.kind === NodeKind.TypedefType) {
    const n = (t as TypedefType).name;
    return n.kind === NodeKind.Identifier && ['SHORT', 'int16_t'].includes((n as Identifier).name);
  }
  if (t.kind === NodeKind.BuiltinType) {
    const b = t as BuiltinType;
    return b.name === 'short' || (b.name === 'int' && b.modifiers.includes('short'));
  }
  return false;
}

function keyCall(e: Expression): boolean {
  const x = unwrapParens(e);
  if (x.kind !== NodeKind.CallExpr) return false;
  const name = calleeName((x as CallExpr).callee);
  return !!name && ['GetKeyState', 'GetAsyncKeyState'].includes(bareName(name));
}

/** A SHORT whose every write is a direct Win32 key-state call. */
function keyStateLocals(fn: FunctionDecl): Set<string> {
  const out = new Set<string>();
  if (!fn.body) return out;
  const candidates = new Set<string>();
  const declarationCount = new Map<string, number>();
  const writes = new Map<string, { key: number; other: number }>();
  const note = (name: string, isKey: boolean): void => {
    const w = writes.get(name) ?? { key: 0, other: 0 };
    if (isKey) w.key++; else w.other++;
    writes.set(name, w);
  };
  for (const n of findNodesByKind(fn.body, NodeKind.VariableDecl)) {
    const d = n as VariableDecl;
    declarationCount.set(d.name.name, (declarationCount.get(d.name.name) ?? 0) + 1);
    if (!shortType(d)) continue;
    candidates.add(d.name.name);
    if (d.initializer) note(d.name.name, keyCall(d.initializer as Expression));
  }
  for (const p of fn.parameters) if (p.name) {
    declarationCount.set(p.name.name, (declarationCount.get(p.name.name) ?? 0) + 1);
  }
  for (const n of findNodesByKind(fn.body, NodeKind.AssignExpr)) {
    const a = n as AssignExpr;
    const lhs = unwrapParens(a.left);
    if (lhs.kind === NodeKind.Identifier && candidates.has((lhs as Identifier).name))
      note((lhs as Identifier).name, a.operator === '=' && keyCall(a.right));
  }
  for (const n of findNodesByKind(fn.body, NodeKind.UnaryExpr)) {
    const u = n as UnaryExpr;
    if (!['&', '++', '--'].includes(u.operator)) continue;
    const x = unwrapParens(u.operand);
    if (x.kind === NodeKind.Identifier && candidates.has((x as Identifier).name)) note((x as Identifier).name, false);
  }
  for (const n of findNodesByKind(fn.body, NodeKind.PostfixExpr)) {
    const x = unwrapParens((n as PostfixExpr).operand);
    if (x.kind === NodeKind.Identifier && candidates.has((x as Identifier).name)) note((x as Identifier).name, false);
  }
  for (const name of candidates) {
    const w = writes.get(name);
    if (w?.key && !w.other && declarationCount.get(name) === 1) out.add(name);
  }
  return out;
}

export function createSignBitTestTransformer(options?: PluginOptions): Transformer {
  const o = (options ?? {}) as PluginOptions & {
    globalTypes?: Record<string, string>;
    enclosingVarTypes?: Record<string, string>;
    structFields?: Record<string, Record<string, string>>;
    fieldTypes?: Record<string, string>;
    functionReturnTypes?: Record<string, string>;
    typedefTargets?: Record<string, string>;
    enumTypes?: string[];
  };
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const keyLocals = keyStateLocals(fn);
      const shapeOf = createExprShape(localTypesOf(fn), {
        globalTypes: o.globalTypes,
        enclosingVarTypes: o.enclosingVarTypes,
        structFields: o.structFields,
        fieldTypes: o.fieldTypes,
        returnTypes: o.functionReturnTypes,
        resolve: name => o.typedefTargets?.[name],
      });
      let changed = false;
      const integralNames = new Set([
        'char', 'signed char', 'unsigned char', 'short', 'short int', 'unsigned short',
        'int', 'unsigned int', 'long', 'long int', 'unsigned long',
        'int8_t', 'uint8_t', 'int16_t', 'uint16_t', 'int32_t', 'uint32_t',
        'byte', 'word', 'dword', 'sbyte', 'sword', 'sdword', 'BYTE', 'WORD', 'DWORD',
        'SHORT', 'USHORT', 'INT', 'UINT', 'LONG', 'ULONG', 'BOOL', 'bool', 'uint', 'ulong',
      ]);
      const predicate = (e: Expression): Expression => {
        if (e.kind === NodeKind.ParenExpr) {
          const p = e as ParenExpr;
          const x = predicate(p.expression);
          return x === p.expression ? e : updateNode(p, { expression: x } as Partial<ParenExpr>);
        }
        if (e.kind === NodeKind.UnaryExpr && (e as UnaryExpr).operator === '!') {
          const u = e as UnaryExpr;
          const x = predicate(u.operand);
          return x === u.operand ? e : updateNode(u, { operand: x } as Partial<UnaryExpr>);
        }
        if (e.kind === NodeKind.CommaExpr) {
          const c = e as CommaExpr;
          const last = c.expressions.length - 1;
          if (last < 0) return e;
          const x = predicate(c.expressions[last]!);
          return x === c.expressions[last] ? e : updateNode(c, { expressions: [...c.expressions.slice(0, last), x] } as Partial<CommaExpr>);
        }
        if (e.kind !== NodeKind.BinaryExpr) return e;
        const b = e as BinaryExpr;
        // The parser also represents parenthesized comma expressions as BinaryExpr
        // with operator ',' (outside BinaryOperator's declared set).
        if ((b.operator as string) === ',') {
          const right = predicate(b.right);
          return right === b.right ? e : updateNode(b, { right } as Partial<BinaryExpr>);
        }
        if (b.operator === '&&' || b.operator === '||') {
          const left = predicate(b.left), right = predicate(b.right);
          return left === b.left && right === b.right ? e : updateNode(b, { left, right } as Partial<BinaryExpr>);
        }
        if ((b.operator !== '<' && b.operator !== '>=') || !zero(b.right)) return e;
        let operand: Expression | undefined;
        let mask: number;
        const lhs = unwrapParens(b.left);
        if (lhs.kind === NodeKind.CStyleCastExpr) {
          const cast = lhs as CStyleCastExpr;
          if (cast.type.kind !== NodeKind.BuiltinType) return e;
          const t = cast.type as BuiltinType;
          if (t.name !== 'char' || t.modifiers.length) return e;
          const s = shapeOf(cast.expression);
          // Unknown expressions may be pointers. A bitwise mask on one would
          // fail to compile, so only rewrite an operand with a known integer or enum type.
          if (!s || s.stars !== 0 || !(integralNames.has(s.base) || o.enumTypes?.includes(s.base))) return e;
          operand = cast.expression;
          mask = 0x80;
        } else if (lhs.kind === NodeKind.Identifier && keyLocals.has((lhs as Identifier).name)) {
          operand = b.left;
          mask = 0x8000;
        } else return e;
        changed = true;
        const bit = Expr.binary(operand, '&', Expr.intLiteral(mask, 16));
        return b.operator === '<' ? bit : Expr.unary('!', Expr.paren(bit));
      };
      const inner = createTransformer({
        visitIfStmt(n: IfStmt): ASTNode | undefined {
          const x = predicate(n.condition);
          return x === n.condition ? undefined : updateNode(n, { condition: x } as Partial<IfStmt>);
        },
        visitWhileStmt(n: WhileStmt): ASTNode | undefined {
          const x = predicate(n.condition);
          return x === n.condition ? undefined : updateNode(n, { condition: x } as Partial<WhileStmt>);
        },
        visitDoWhileStmt(n: DoWhileStmt): ASTNode | undefined {
          const x = predicate(n.condition);
          return x === n.condition ? undefined : updateNode(n, { condition: x } as Partial<DoWhileStmt>);
        },
        visitForStmt(n: ForStmt): ASTNode | undefined {
          if (!n.condition) return undefined;
          const x = predicate(n.condition);
          return x === n.condition ? undefined : updateNode(n, { condition: x } as Partial<ForStmt>);
        },
        visitNode(raw: ASTNode): ASTNode | undefined {
          if (raw.kind !== NodeKind.ConditionalExpr) return undefined;
          const n = raw as ConditionalExpr;
          const x = predicate(n.condition);
          return x === n.condition ? undefined : updateNode(n, { condition: x } as Partial<ConditionalExpr>);
        },
      });
      const body = inner(fn.body);
      return changed ? updateNode(fn, { body } as Partial<FunctionDecl>) : undefined;
    },
  });
}

export const signBitTestPlugin: TransformPlugin = createPlugin(
  'sign-bit-test',
  'Sign Bit Test',
  'Spells byte and key-state sign predicates as masks for VC8 branch fidelity',
  (options?: PluginOptions) => createSignBitTestTransformer(options),
  { priority: 989.995, defaultEnabled: true, tags: ['matching', 'cpp'], version: '1.0.0' },
);

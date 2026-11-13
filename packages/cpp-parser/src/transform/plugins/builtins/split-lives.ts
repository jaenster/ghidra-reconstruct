/**
 * Split Lives Plugin
 *
 * VC8 keeps several values in one place when their lifetimes do not overlap: one stack
 * slot (often a parameter's, once the parameter is dead) or one register holds an
 * integer, later a string pointer, later a unit pointer. The decompiler merges what
 * shares a slot into ONE variable - a stack parameter or an address-tied frame slot
 * cannot be split at all, its first-use offset is ignored on stack storage - and prints
 * that variable with the first value's type and a cast at every touch of the others:
 *
 *   nStatValue = (int32_t)D2Lang::...::GetLocaleString(0xf9b);
 *   ...
 *   AppendToBuffer(wszOutputBuffer, (uint16_t *)nStatValue);
 *
 * (ItemStatCost_DescFunc_DGrpFunc @004e4d80). The source had separate variables the
 * compiler happened to place in one slot. This pass gives each later value back a
 * variable of its own, typed from its own uses:
 *
 *   wszStatValue = D2Lang::...::GetLocaleString(0xf9b);
 *   ...
 *   AppendToBuffer(wszOutputBuffer, wszStatValue);
 *
 * The lives are the variable's webs: by reaching definitions over the CFG, every read
 * joins the definitions that reach it into one web, so two values a read can see from
 * either side (a JOIN: a loop around a store, a merge after an if) are one web and stay
 * one variable. Nothing is guessed: a web is moved to a new local only when
 *  - the variable is a parameter or a top-level local of a 4-byte word type (integer or
 *    pointer), declared once, whose address is never taken, and - when it lives in a
 *    frame slot - in a function where no frame slot's address is taken (a callee reaching
 *    past a neighbour's address would write it behind the split's back);
 *  - every write of it is a whole statement `v = e;`, `v op= e;`, `v++;` or `v--;`;
 *  - the web does not hold the entry value (a parameter's own value, or a local read
 *    before any store) and is read at least once;
 *  - its type is evident: every read that casts it to a pointer casts it to one type T, or
 *    (reads disagreeing or not casting) every store that is not a constant stores a
 *    value evidently of one type T;
 *  - T is of the other class than the declared type (a pointer life in an integer, an
 *    integer life in a pointer) or a pointer to another type, and the move removes more
 *    pointer/integer casts than it needs.
 *
 * The rewrite keeps every bit, since both types are one 4-byte word on the target: a
 * read `(T)v` becomes the local, a read cast to another type `(C)local` (through the
 * declared type where C is an integer of another width), a bare read `(DT)local`; a
 * store `v = (DT)x` stores x (cast to T where x is evidently another pointer), any
 * other store `(T)(e)`; `v op= e` becomes `local = (T)((DT)local op e)`.
 */

import { appendFileSync } from 'node:fs';
import { NodeKind } from '../../../ast/kinds.js';
import { TriviaKind } from '../../../lexer/trivia.js';
import type {
  ASTNode, AssignExpr, BinaryExpr, CallExpr, CompoundStmt, CStyleCastExpr, DeclStmt, ExprStmt, Expression,
  FunctionDecl, Identifier, ParameterDecl, PostfixExpr, StaticAssertDecl, Statement, TypeNode, UnaryExpr, UnionDecl,
  VariableDecl,
} from '../../../ast/nodes.js';
import { Expr, Decl, Stmt, Type } from '../../../ast/factory.js';
import { findNodesByKind } from '../../../ast/visitor.js';
import { emit } from '../../../emit/index.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin, PluginOptions } from '../types.js';
import { buildFunctionFlow, calleeSpelling, ENTRY_DEF, funcdefOutWidth, type FunctionFlow, type Reach } from '../../cfg/index.js';
import { callNeedsFrame, frameAliasOffset, knownCountWrites, movableLocals } from './frame-group-locals.js';
import { isSecurityCookieSeed } from './boilerplate-cleanup.js';
import { stackNameOffset, type StackSlot } from './stack-frame-address.js';
import { unwrapParens, calleeName, bareName, typeFromSpelling } from './call-arg-cast.js';
import {
  evidentType, isConstantStore, sameType, spellingOf, valueLocalName, wordClass,
  type ReusedParamSlotOptions,
} from './reused-param-slot.js';

export interface SplitLivesOptions extends PluginOptions {
  /** Callable name (bare AND qualified) -> declared return type, for a store's value type. */
  functionReturnTypes?: Record<string, string>;
  /** Callable name (bare AND qualified) -> its parameter type spellings: where an argument's value goes. */
  functionParamTypes?: Record<string, string[]>;
  /** Aggregate -> field -> declared spelling. */
  structFields?: Record<string, Record<string, string>>;
  /** Field name -> spelling, where every aggregate declaring it agrees. */
  fieldTypes?: Record<string, string>;
  /** Global name -> declared spelling. */
  globalTypes?: Record<string, string>;
  /** Every enum constant name: a store of one is a constant. */
  enumConstants?: readonly string[];
  /** Aggregate -> every field's offset, size and Ghidra type: where `&p->f` lands from p. */
  structLayouts?: Record<string, ReadonlyArray<{ name: string; offset: number; size: number; type: string; bitSize?: number }>>;
  /** Aggregate -> its size in bytes. */
  aggregateSizes?: Record<string, number>;
  /**
   * The enclosing function's frame, from Ghidra's own variable list. A local is split
   * only where frame-group-locals cannot make it a member of a frame object - no
   * address of a slot below it leaves the frame - since a callee reaching past that
   * address writes the member behind the split's back. Absent: the pass does not run.
   */
  slots?: readonly StackSlot[];
  /** Each callee's reach through a pointer parameter, as frame-group-locals is given it. */
  argReach?: (callee: string, index: number, argCount: number) => Reach;
  /** The same for a computed callee. */
  computedArgReach?: (callee: Expression, index: number, argCount: number) => Reach;
  /**
   * The bytes this body reaches through one of its own names, read as a callee's parameter
   * is (with `include` leaving uses out): a local pointer that only ever holds a frame
   * local's address bounds that address's escape.
   */
  bodyReach?: (body: ASTNode, name: string, type: string, opts: { include: (use: ASTNode) => boolean }) => Reach;
  /** A callee's out-parameter width at an argument position (from its body), or null. */
  outParamWidth?: (callee: string, index: number) => number | null;
  /**
   * The same, for an argument that is not null (`&v` never is): a store the callee guards
   * with its own null test of the parameter is made on every path such a call takes.
   */
  outParamWidthNonNull?: (callee: string, index: number) => number | null;
  /** The function as the run's report names it (address and name); the body's own name otherwise. */
  reportName?: string;
  /** One line per variable the pass split or refused, for the run's report. */
  onReport?: (fn: string, line: string) => void;
  /**
   * A local a frame object may hold (a callee reaching past a neighbour's address can
   * read or write its slot) keeps its slot: each life it would split into a local of its
   * own becomes a member of a union declared in its place instead, so every life still
   * sits in the one 4-byte slot the frame object covers. Absent or false: such a local is
   * not split.
   */
  slotUnions?: boolean;
}

type WordClass = 'ptr' | 'int';

interface Write {
  node: number;
  /** The assignment or increment the node evaluates. */
  expr: Expression;
  /**
   * 'touch': a call handed `&v`, whose callee is known to reach only the word itself and
   * keep no copy of the address. The call reads and may write the variable while it runs.
   */
  kind: 'assign' | 'compound' | 'touch' | 'out';
  /**
   * 'out': a touch whose callee stores a whole word through the address before it reads
   * one (an out-parameter, from the callee's body) and the node reads v nowhere else: it
   * replaces the value, so a new value starts there. The placeholder standing for `&v`
   * and the type the call casts the address to.
   */
  placeholder?: Expression;
  castType?: TypeNode;
  /**
   * An 'out' call whose other arguments also read v (`f(v->a, &v)`): they are evaluated
   * before the call, so they read the value that reaches the node, and the call's store
   * begins the next.
   */
  readsBefore?: boolean;
  /**
   * An 'assign' inside a larger expression (`if ((v = f()) != 0)`, `a = (v = x, y)`),
   * evaluated whenever its node is; true when the enclosing expression uses its value.
   */
  nested?: { consumed: boolean };
}

interface Occurrence {
  id: Identifier;
  /** The cast whose operand (through parentheses) is this read, if any. */
  cast: CStyleCastExpr | null;
  /**
   * A bare read displaced by a literal inside an integer cast to a pointer, `(T *)(v + 4)`:
   * the cast that reads v as an address, which a pointer life reads as `(T *)((DT)p + 4)`
   * and pointer-word-cast spells with a pointer-sized integer.
   */
  offset: CStyleCastExpr | null;
  /**
   * An integer cast of the value inside such a displacement, `(T *)((int)p + 4)`: the
   * pointer cast the address arithmetic ends in. The value is read as an address, not as
   * a number.
   */
  via: CStyleCastExpr | null;
  /**
   * An uncast read the value goes straight on from: the type of the parameter it is
   * passed to, of the place it is stored to, or the function's return type.
   */
  sink: TypeNode | null;
  /**
   * An uncast read only tested for truth (`!v`, `if (v)`, `v && x`, `v == 0`): a pointer
   * and an integer of the same bits test alike, so it needs no cast in either type.
   */
  truth: boolean;
  /**
   * An uncast read compared for (in)equality with a constant, `v != (char *)0x202`: the
   * constant, cast or bare. Equal bits compare equal in either type.
   */
  eqWith: Expression | null;
  /**
   * The address of a member reached through the value, `(int)&v->f` or an array member
   * decaying in `(int)(v->abBuf + n)`, whose integer an integer life computes as `n + 0x30`:
   * the node the address is, and its byte offset from the value.
   */
  interior?: { node: object; offset: number; cast: CStyleCastExpr | null };
  /**
   * An uncast read ordered against a constant, `v < (char *)0x100`: two pointers compare
   * unsigned, so an integer life compares its number as unsigned with the constant's.
   */
  relWith?: Expression;
}

class UnionFind {
  private parent = new Map<number, number>();
  find(x: number): number {
    let p = this.parent.get(x);
    if (p === undefined) { this.parent.set(x, x); return x; }
    while (p !== x) {
      const g = this.parent.get(p)!;
      this.parent.set(x, g);
      x = p; p = g;
    }
    return x;
  }
  union(a: number, b: number): void {
    const ra = this.find(a), rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const COMPOUND_OPS: Readonly<Record<string, string>> = {
  '+=': '+', '-=': '-', '*=': '*', '/=': '/', '%=': '%', '&=': '&', '|=': '|', '^=': '^', '<<=': '<<', '>>=': '>>',
};

function isIdent(e: Expression | null | undefined, name: string): boolean {
  if (!e) return false;
  const u = unwrapParens(e);
  return u.kind === NodeKind.Identifier && (u as Identifier).name === name;
}

/** The write a node's own expression makes of `v`, when it is one of the accepted whole-statement forms. */
function wholeWrite(flow: FunctionFlow, node: number, v: string): Write | null {
  const n = flow.cfg.nodes[node];
  const own = flow.ownExprs(node);
  if (own.length !== 1) return null;
  if (n.stmt && n.stmt.kind !== NodeKind.ExprStmt) return null;
  const e = unwrapParens(own[0]);
  if (e.kind === NodeKind.AssignExpr) {
    const a = e as AssignExpr;
    if (!isIdent(a.left, v)) return null;
    if (a.operator === '=') return { node, expr: e, kind: 'assign' };
    // An update reading the variable on its right as well is not rewritten.
    if (COMPOUND_OPS[a.operator] && !findNodesByKind(a.right as unknown as ASTNode, NodeKind.Identifier).some(id => (id as Identifier).name === v)) {
      return { node, expr: e, kind: 'compound' };
    }
    return null;
  }
  if (e.kind === NodeKind.UnaryExpr || e.kind === NodeKind.PostfixExpr) {
    const op = (e as UnaryExpr).operator;
    const operand = (e as UnaryExpr | PostfixExpr).operand;
    if ((op === '++' || op === '--') && isIdent(operand, v)) return { node, expr: e, kind: 'compound' };
  }
  return null;
}

/**
 * The write a node makes of `v` from inside a larger expression, `if ((v = f()) != 0)` or
 * `a = (v = x, y)`: a plain `v = e` reached only through operands that are always
 * evaluated (not the right of `&&`/`||`, not a branch of `?:`, not under `&` or `sizeof`),
 * and the only mention of v in the node - a read beside it would see one value or the
 * other by evaluation order, which the node-level dataflow does not model. Null otherwise.
 */
function nestedWrite(flow: FunctionFlow, node: number, v: string): Write | null {
  const own = flow.ownExprs(node);
  let mentions = 0;
  for (const e of own) {
    for (const id of findNodesByKind(e as unknown as ASTNode, NodeKind.Identifier)) if ((id as Identifier).name === v) mentions++;
  }
  if (mentions !== 1) return null;
  /**
   * How the enclosing expression uses a value: not at all, only as a truth value (a
   * condition, an operand of `!`, `&&`, `||`, a comparison with 0) - where a pointer and
   * an integer of the same bits test alike - or as a value of its type.
   */
  type Use = 'none' | 'truth' | 'value';
  const isZero = (e: Expression) => { const u = unwrapParens(e); return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 0n; };
  let found: Write | null = null;
  const visit = (x: unknown, sure: boolean, use: Use): void => {
    if (found || !x || typeof x !== 'object') return;
    const n = x as ASTNode;
    switch (n.kind) {
      case NodeKind.AssignExpr: {
        const a = n as AssignExpr;
        if (a.operator === '=' && isIdent(a.left, v)) {
          if (sure) found = { node, expr: a as unknown as Expression, kind: 'assign', nested: { consumed: use === 'value' } };
          return;
        }
        visit(a.right, sure, 'value');
        visit(a.left, sure, 'value');
        return;
      }
      case NodeKind.ParenExpr:
        visit((n as unknown as { expression: Expression }).expression, sure, use);
        return;
      case NodeKind.CommaExpr: {
        const xs = (n as unknown as { expressions: Expression[] }).expressions;
        xs.forEach((e, i) => visit(e, sure, i === xs.length - 1 ? use : 'none'));
        return;
      }
      case NodeKind.BinaryExpr: {
        const b = n as BinaryExpr;
        const logical = b.operator === '&&' || b.operator === '||';
        const zeroTest = b.operator === '==' || b.operator === '!=';
        visit(b.left, sure, logical || (zeroTest && isZero(b.right)) ? 'truth' : 'value');
        visit(b.right, sure && !logical, logical || (zeroTest && isZero(b.left)) ? 'truth' : 'value');
        return;
      }
      case NodeKind.ConditionalExpr: {
        const c = n as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
        visit(c.condition, sure, 'truth');
        visit(c.thenExpr, false, 'value');
        visit(c.elseExpr, false, 'value');
        return;
      }
      case NodeKind.UnaryExpr: {
        const u = n as UnaryExpr;
        if (u.operator === '&') return;
        visit(u.operand, sure, u.operator === '!' ? 'truth' : 'value');
        return;
      }
      case NodeKind.CStyleCastExpr:
        visit((n as CStyleCastExpr).expression, sure, 'value');
        return;
      case NodeKind.CallExpr: {
        const c = n as CallExpr;
        visit(c.callee, sure, 'value');
        for (const a of c.arguments) visit(a, sure, 'value');
        return;
      }
      case NodeKind.SubscriptExpr:
      case NodeKind.MemberExpr:
      case NodeKind.PostfixExpr:
        for (const [k, val] of Object.entries(n)) {
          if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
          if (val && typeof val === 'object' && 'kind' in (val as object)) visit(val, sure, 'value');
        }
        return;
      default:
        // Anything else (sizeof, a lambda, an initializer list): not followed.
        return;
    }
  };
  const stmt = flow.cfg.nodes[node].stmt;
  const k = stmt?.kind;
  // The value of an expression statement (or a for loop's increment, or a condition's
  // comma operand) is discarded; a condition's, or a condition operand's, is a truth value.
  const top: Use = flow.cfg.nodes[node].condPart === 'test' ? 'truth'
    : !stmt || k === NodeKind.ExprStmt ? 'none'
    : k === NodeKind.IfStmt || k === NodeKind.WhileStmt || k === NodeKind.DoWhileStmt || k === NodeKind.ForStmt ? 'truth'
    : 'value';
  for (const e of own) visit(e, true, top);
  return found;
}

/** The cast class a spelling has for this pass: a pointer, a 4-byte integer, or neither. */
function classOf(spelling: string): WordClass | null {
  const c = wordClass(spelling);
  return c === 'ptr' || c === 'int' ? c : null;
}

/** A life's class: a pointer, or an integer - an enum is one, declared as an integer type. */
function lifeClass(spelling: string): WordClass | null {
  return classOf(spelling) ?? (wordClass(spelling) === 'enum' ? 'int' : null);
}

/**
 * SDK typedefs that ARE a pointer (winnt.h, minwindef.h, minwinbase.h): a variable declared
 * with one holds an address as surely as one spelled `T *`.
 */
const POINTER_TYPEDEFS = new Set([
  'LPVOID', 'LPCVOID', 'PVOID', 'LPSTR', 'LPCSTR', 'LPWSTR', 'LPCWSTR', 'PSTR', 'PCSTR', 'PWSTR', 'PCWSTR',
  'LPBYTE', 'PBYTE', 'LPWORD', 'PWORD', 'LPDWORD', 'PDWORD', 'LPLONG', 'PLONG', 'LPINT', 'PINT', 'LPBOOL', 'PBOOL',
  'LPHANDLE', 'PHANDLE', 'LPFILETIME', 'PFILETIME', 'LPOVERLAPPED', 'LPSECURITY_ATTRIBUTES', 'PULONG', 'PUINT',
]);

/**
 * The class of a candidate's DECLARED type: a pointer or 4-byte integer spelling, a pointer
 * typedef of the SDK, or an enum - which MSVC lays out as an `int`, so a pointer kept in an
 * enum-typed variable is a pointer in an integer word like any other.
 */
function declaredClassOf(spelling: string): WordClass | null {
  const c = classOf(spelling);
  if (c) return c;
  if (POINTER_TYPEDEFS.has(spelling)) return 'ptr';
  if (wordClass(spelling) === 'enum') return 'int';
  return null;
}

function lookupName<T>(table: Record<string, T> | undefined, name: string): T | undefined {
  if (!table) return undefined;
  return table[name] ?? table[bareName(name)];
}

const INT_OPS = new Set(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>']);

/**
 * Integer types narrower than the word: a read `(char)v` of an integer life is the same
 * truncation of the same 32 bits as `(char)(DT *)v` was, so it needs no pointer in between.
 */
const NARROW_INTEGERS = new Set([
  'char', 'signed char', 'unsigned char', 'uchar', 'byte', 'BYTE', 'CHAR', 'UCHAR', 'int8_t', 'uint8_t', 'undefined1',
  'bool', 'BOOLEAN', 'short', 'short int', 'unsigned short', 'unsigned short int', 'ushort', 'SHORT', 'USHORT', 'WORD',
  'int16_t', 'uint16_t', 'undefined2', 'wchar_t', 'WCHAR',
]);

/**
 * The cast class of a stored value: its evident type's, or an integer for arithmetic on
 * integers (`a - b`, `-(int)p`), which no declared type names but which is a number all
 * the same. A store cast through the declared pointer type, `p = (T *)(a - b)`, then
 * moves into an integer life without the cast instead of through two.
 */
function valueClass(e: Expression, o: ReusedParamSlotOptions, localTypes: ReadonlyMap<string, TypeNode>, enumConstants: ReadonlySet<string>): WordClass | 'enum' | null {
  const t = evidentType(e, o, localTypes);
  if (t) return wordClass(spellingOf(t));
  const x = unwrapParens(e);
  if (x.kind === NodeKind.IntegerLiteral) return 'int';
  if (x.kind === NodeKind.Identifier && enumConstants.has((x as Identifier).name)) return 'int';
  if (x.kind === NodeKind.UnaryExpr && ['-', '~'].includes((x as UnaryExpr).operator)) {
    return isNumber(valueClass((x as UnaryExpr).operand, o, localTypes, enumConstants)) ? 'int' : null;
  }
  if (x.kind === NodeKind.BinaryExpr && INT_OPS.has((x as BinaryExpr).operator)) {
    const b = x as BinaryExpr;
    return isNumber(valueClass(b.left, o, localTypes, enumConstants)) && isNumber(valueClass(b.right, o, localTypes, enumConstants)) ? 'int' : null;
  }
  return null;
}
const isNumber = (c: WordClass | 'enum' | null) => c === 'int' || c === 'enum';

/**
 * The size on the 32-bit target of what a pointer spelled `spelling` points at, where the
 * spelling alone says it: a builtin or fixed-width integer, a float, or a pointer. Null for
 * anything else (an aggregate, void, a function).
 */
function pointeeSize(spelling: string): number | null {
  const m = /^(?:const\s+)?(.*?)\s*\*$/.exec(spelling.trim());
  if (!m) return null;
  const t = m[1].trim();
  if (t.endsWith('*')) return 4;
  if (NARROW_INTEGERS.has(t)) {
    return ['short', 'short int', 'unsigned short', 'unsigned short int', 'ushort', 'SHORT', 'USHORT', 'WORD', 'int16_t',
      'uint16_t', 'undefined2', 'wchar_t', 'WCHAR'].includes(t) ? 2 : 1;
  }
  if (['int', 'unsigned int', 'uint', 'int32_t', 'uint32_t', 'long', 'unsigned long', 'ulong', 'LONG', 'ULONG', 'DWORD',
    'UINT', 'INT', 'BOOL', 'float', 'undefined4'].includes(t)) return 4;
  if (['double', 'int64_t', 'uint64_t', 'longlong', 'ulonglong', 'undefined8', 'LONGLONG', 'ULONGLONG'].includes(t)) return 8;
  return null;
}

const GHIDRA_SIZES: Readonly<Record<string, number>> = {
  undefined: 1, undefined1: 1, byte: 1, undefined2: 2, word: 2, undefined4: 4, dword: 4, undefined8: 8, qword: 8,
};

/** An aggregate's layout name from a spelling: qualifiers, namespaces and the pointer off. */
const aggregateName = (t: string) => t.replace(/^(?:const|struct|union)\s+/, '').replace(/\s*\*\s*$/, '').trim().replace(/^.*::/, '');

/** A signed integer literal's value (`5`, `-0x19`), null otherwise. */
function literalValue(e: Expression): bigint | null {
  const l = literalOf(e);
  if (!l) return null;
  const u = unwrapParens(l);
  if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value;
  return -((unwrapParens((u as UnaryExpr).operand) as unknown as { value: bigint }).value);
}

/**
 * A life stepping itself by an integer: `v += e`, `v -= e`, `v++`, `v--`, or `v = v + e`,
 * `v = e + v`, `v = v - e` (through parentheses and a cast to the declared type `dt`),
 * with `e` not mentioning v. The operator and the step; `e` is null for `++`/`--`.
 */
function selfStep(w: Write, v: string, dt: string, isPointer: (e: Expression) => boolean): { op: '+' | '-'; step: Expression | null } | null {
  const e = w.expr;
  if (w.kind === 'compound') {
    if (e.kind === NodeKind.AssignExpr) {
      const a = e as AssignExpr;
      if (a.operator !== '+=' && a.operator !== '-=') return null;
      if (isPointer(a.right)) return null;
      return { op: a.operator === '+=' ? '+' : '-', step: a.right };
    }
    return { op: (e as UnaryExpr).operator === '++' ? '+' : '-', step: null };
  }
  if (w.kind !== 'assign' || w.nested) return null;
  let r = unwrapParens((e as AssignExpr).right);
  if (r.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((r as CStyleCastExpr).type), dt)) r = unwrapParens((r as CStyleCastExpr).expression);
  if (r.kind !== NodeKind.BinaryExpr) return null;
  const b = r as BinaryExpr;
  if (b.operator !== '+' && b.operator !== '-') return null;
  const mentions = (x: Expression) => findNodesByKind(x as unknown as ASTNode, NodeKind.Identifier).some(id => (id as Identifier).name === v);
  // `p - q` of two pointers is a distance, not a step.
  if (isIdent(b.left, v) && !mentions(b.right) && !isPointer(b.right)) return { op: b.operator, step: b.right };
  if (b.operator === '+' && isIdent(b.right, v) && !mentions(b.left) && !isPointer(b.left)) return { op: '+', step: b.left };
  return null;
}

/** `&x`: a pointer value whatever x's type, through parentheses. */
function isAddressOf(e: Expression): boolean {
  const u = unwrapParens(e);
  return u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&';
}

/**
 * Whether `e` computes with the value of `v` itself, not only with something loaded
 * through it (`v->pNext`, `*v`, `v[2]`).
 */
function steps(e: Expression, v: string): boolean {
  const walk = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.some(walk);
    if (!x || typeof x !== 'object') return false;
    const n = x as ASTNode;
    if (n.kind === NodeKind.Identifier) return (n as Identifier).name === v;
    // `&v->f` is v's value plus an offset.
    if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '&') {
      return findNodesByKind((n as UnaryExpr).operand as unknown as ASTNode, NodeKind.Identifier).some(id => (id as Identifier).name === v);
    }
    let base: Expression | null = null;
    if (n.kind === NodeKind.MemberExpr && (n as unknown as { isArrow: boolean }).isArrow) base = (n as unknown as { object: Expression }).object;
    else if (n.kind === NodeKind.UnaryExpr && (n as UnaryExpr).operator === '*') base = (n as UnaryExpr).operand;
    else if (n.kind === NodeKind.SubscriptExpr) base = (n as unknown as { array: Expression }).array;
    for (const [k, val] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
      if (base && val === base && isIdent(base, v)) continue;
      if (val && typeof val === 'object' && walk(val)) return true;
    }
    return false;
  };
  return walk(e);
}

/** Every identifier in the body, declarations and references alike: names a new local must not take. */
function namesIn(body: ASTNode): Set<string> {
  const out = new Set<string>();
  for (const id of findNodesByKind(body, NodeKind.Identifier)) out.add((id as Identifier).name);
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) out.add((d as VariableDecl).name.name);
  return out;
}

/**
 * The frame locals a callee may reach through an address that leaves the frame, which
 * frame-group-locals may make members of a frame object. A reach starts at:
 * a local whose address leaves the frame (handed to a call that reaches past it or
 * whose reach is unknown, stored, used as an initialiser - anything but a dereference),
 * a local a counted copy or fill (`memset(buf, 0, 0x40)`) writes, and - when the body
 * names a frame base no slot carries - the lowest local. Where every escape of the local
 * is a call whose reach is known (`[0, 8)`) or a counted write, it covers those bytes
 * and the locals they overlap; otherwise it extends through every local that follows
 * with a hole of at most one word (frame-group-locals' MAX_GAP) - the widest a run can
 * reach. A local outside every reach is not split behind the callee's back: no callee
 * touches it. With the members, why each seed whose reach is unknown is so: the escape
 * that left it unbounded, for the run's report.
 */
function frameReach(body: CompoundStmt, slots: readonly StackSlot[], o: SplitLivesOptions): { members: Map<string, string>; why: Map<string, string> } {
  const offsetOf = new Map<string, StackSlot>();
  for (const s of slots) if (!s.isParameter) offsetOf.set(s.name, s);
  /** Seed -> the bytes its escapes are known to reach from its start, or null when unknown. */
  const seeds = new Map<string, number | null>();
  const why = new Map<string, string>();
  let baseFold = false;
  const seed = (name: string, bytes: number | null, reason?: () => string) => {
    if (!offsetOf.has(name)) return;
    if (bytes === null && !why.has(name) && reason) why.set(name, reason());
    if (!seeds.has(name)) { seeds.set(name, bytes); return; }
    const prev = seeds.get(name)!;
    seeds.set(name, prev === null || bytes === null ? null : Math.max(prev, bytes));
  };
  for (const [name, bytes] of knownCountWrites(body, movableLocals(body))) seed(name, Math.max(bytes, offsetOf.get(name)?.size ?? 0));
  /**
   * The reach through `target` (the left of `target = &x`) when it is a local pointer
   * whose every store is `= &x` (through casts and parentheses) - so every value it holds
   * is x's address - and no other write touches it: its uses, read as a callee reads a
   * parameter, are what x's address reaches. Null when that is not so or not known.
   */
  const declaredTypes = new Map<string, TypeNode | null>();
  for (const d of findNodesByKind(body as unknown as ASTNode, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    declaredTypes.set(v.name.name, declaredTypes.has(v.name.name) ? null : v.type);
  }
  const aliasReach = (target: Expression, x: string): Reach => {
    if (!o.bodyReach || target.kind !== NodeKind.Identifier) return null;
    const q = (target as Identifier).name;
    const type = declaredTypes.get(q);
    if (!type) return null;
    const spelling = spellingOf(type);
    if (classOf(spelling) !== 'ptr') return null;
    const stores = new Set<ASTNode>();
    let only = true;
    for (const a of findNodesByKind(body as unknown as ASTNode, NodeKind.AssignExpr)) {
      const as = a as AssignExpr;
      if (!isIdent(as.left, q)) continue;
      let r = unwrapParens(as.right);
      while (r.kind === NodeKind.CStyleCastExpr) r = unwrapParens((r as CStyleCastExpr).expression);
      if (as.operator === '=' && r.kind === NodeKind.UnaryExpr && (r as UnaryExpr).operator === '&' && isIdent((r as UnaryExpr).operand, x)) {
        stores.add(unwrapParens(as.left) as unknown as ASTNode);
      } else { only = false; break; }
    }
    if (!only || stores.size === 0) return null;
    // A declaration with an initializer is a store this does not model; the bare one
    // names q, it does not use it.
    for (const d of findNodesByKind(body as unknown as ASTNode, NodeKind.VariableDecl) as VariableDecl[]) {
      if (d.name.name !== q) continue;
      if (d.initializer) return null;
      stores.add(d.name as unknown as ASTNode);
    }
    return o.bodyReach(body as unknown as ASTNode, q, spelling, { include: use => !stores.has(use) });
  };
  /**
   * The /GS cookie seeds `c = DEFAULT_SECURITY_COOKIE ^ (uint)&stack0xfffffffc;` whose
   * local the body names nowhere else: boilerplate-cleanup deletes the statement, and the
   * frame address in it reaches nothing.
   */
  const cookieSeeds = new Set<ASTNode>();
  {
    // References only: a declaration's own name is not one.
    const declNames = new Set<ASTNode>(findNodesByKind(body as unknown as ASTNode, NodeKind.VariableDecl).map(d => (d as VariableDecl).name as unknown as ASTNode));
    const mentions = new Map<string, number>();
    for (const id of findNodesByKind(body as unknown as ASTNode, NodeKind.Identifier)) {
      if (declNames.has(id)) continue;
      mentions.set((id as Identifier).name, (mentions.get((id as Identifier).name) ?? 0) + 1);
    }
    for (const st of findNodesByKind(body as unknown as ASTNode, NodeKind.ExprStmt)) {
      const e = unwrapParens((st as ExprStmt).expression);
      if (e.kind !== NodeKind.AssignExpr || (e as AssignExpr).operator !== '=') continue;
      const t = unwrapParens((e as AssignExpr).left);
      if (t.kind !== NodeKind.Identifier || !isSecurityCookieSeed((e as AssignExpr).right)) continue;
      // The store is its only reference.
      if (mentions.get((t as Identifier).name) === 1) cookieSeeds.add((e as AssignExpr).right as unknown as ASTNode);
    }
  }
  const walk = (x: unknown, chain: ASTNode[]): void => {
    if (Array.isArray(x)) { for (const i of x) walk(i, chain); return; }
    if (!x || typeof x !== 'object') return;
    const node = x as ASTNode;
    if (cookieSeeds.has(node)) return;
    if (node.kind === NodeKind.Identifier && /stack0x/.test((node as Identifier).name)) {
      // A frame position the decompiler names by offset: in the argument area it is no
      // local's; on a local's slot it is that local's address or its word by another name,
      // a seed and a member; anywhere else it is a frame base, which frame-group-locals
      // seeds at the lowest local so the run reaches every object the fold might touch.
      const at = stackNameOffset((node as Identifier).name);
      if (at !== null && at >= 0) return;
      const slot = at === null ? undefined : slots.find(x => !x.isParameter && x.offset === at);
      if (!slot) { baseFold = true; return; }
      seed(slot.name, null, () => `named by offset ${(node as Identifier).name}`);
      return;
    }
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&') {
      const target = unwrapParens((node as UnaryExpr).operand);
      if (target.kind === NodeKind.Identifier) {
        const name = (target as Identifier).name;
        let i = chain.length - 1;
        let child: ASTNode = node;
        while (i >= 0 && (chain[i].kind === NodeKind.ParenExpr || chain[i].kind === NodeKind.CStyleCastExpr)) { child = chain[i]; i--; }
        const parent = i >= 0 ? chain[i] : null;
        let harmless = false;
        let reach: Reach | undefined;
        if (parent?.kind === NodeKind.UnaryExpr && (parent as UnaryExpr).operator === '*') harmless = true;
        else if (parent?.kind === NodeKind.AssignExpr && (parent as AssignExpr).operator === '=' && (parent as AssignExpr).right === child) {
          // `q = &x`: where q only ever holds x's address, q's own uses are the escape.
          reach = aliasReach(unwrapParens((parent as AssignExpr).left), name) ?? undefined;
        }
        else if (parent?.kind === NodeKind.CallExpr) {
          const call = parent as CallExpr;
          const index = call.arguments.indexOf(child as Expression);
          const size = offsetOf.get(name)?.size;
          harmless = index >= 0 && o.argReach !== undefined
            && !callNeedsFrame(call, index, name, o.argReach, () => size, e => { reach = e.reach; }, o.computedArgReach);
        }
        if (!harmless) seed(name, reach && reach.lo >= 0 ? reach.hi : null, () => {
          const at = (parent ?? node) as unknown as Expression;
          let text = '?';
          try { text = emit(at as never).replace(/\s+/g, ' ').slice(0, 100); } catch { /* the report only */ }
          return `${parent ? NodeKind[parent.kind] : 'top'}: ${text}`;
        });
      }
    }
    const next = [...chain, node];
    for (const [k, val] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia') continue;
      if (val && typeof val === 'object') walk(val, next);
    }
  };
  walk(body.statements, []);
  const locals = slots.filter(s => !s.isParameter && s.offset < 0 && s.size > 0).sort((a, b) => a.offset - b.offset);
  if (baseFold && locals.length > 0) seed(locals[0].name, null, () => 'a frame base no slot carries');
  /** Member -> the local whose address reaches it. */
  const members = new Map<string, string>();
  for (const [name, bytes] of seeds) {
    const i = locals.findIndex(s => s.name === name);
    if (i < 0) continue;
    members.set(name, name);
    if (bytes !== null) {
      // A known reach: the locals the bytes [start, start + bytes) overlap.
      const end = locals[i].offset + bytes;
      for (let j = i + 1; j < locals.length && locals[j].offset < end; j++) {
        if (!members.has(locals[j].name)) members.set(locals[j].name, name);
      }
      continue;
    }
    let end = locals[i].offset + locals[i].size;
    for (let j = i + 1; j < locals.length && locals[j].offset <= end + 4; j++) {
      if (!members.has(locals[j].name)) members.set(locals[j].name, name);
      end = Math.max(end, locals[j].offset + locals[j].size);
    }
  }
  return { members, why };
}

/**
 * The body with every `&v` replaced by a placeholder the dataflow reads as a read and a
 * write of v at that call (`v += 0`), when each one is handed straight to a call whose
 * callee is known to reach only bytes [0, 4) of it - the reach analysis calls an address
 * that is stored, returned or computed with unknown, so a known reach also says the
 * callee keeps no copy of it. Null when some `&v` is anything else.
 */
function callScopedAddresses(statements: Statement[], v: string, o: SplitLivesOptions, funcdefOf: (callee: Expression) => string | null):
  { statements: Statement[]; placeholders: Map<object, Expression>; outs: Set<object>; casts: Map<object, TypeNode | null> } | { why: string } {
  const placeholders = new Map<object, Expression>();
  /** Placeholders handed to an out-parameter. */
  const outs = new Set<object>();
  /** Every placeholder's pointer type the address is cast to, null when it is not cast. */
  const casts = new Map<object, TypeNode | null>();
  let bad = false;
  let why = '';
  const visit = (x: unknown, chain: ASTNode[]): unknown => {
    if (bad) return x;
    if (Array.isArray(x)) {
      let ch = false;
      const out = x.map(i => { const r = visit(i, chain); if (r !== i) ch = true; return r; });
      return ch ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const node = x as ASTNode;
    if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '&' && isIdent((node as UnaryExpr).operand, v)) {
      let i = chain.length - 1;
      let child: ASTNode = node;
      while (i >= 0 && (chain[i].kind === NodeKind.ParenExpr || chain[i].kind === NodeKind.CStyleCastExpr)) { child = chain[i]; i--; }
      const parent = i >= 0 ? chain[i] : null;
      const call = parent?.kind === NodeKind.CallExpr ? parent as CallExpr : null;
      const index = call ? call.arguments.indexOf(child as Expression) : -1;
      // A call through a function-pointer type whose contract fixes the argument as a
      // one-word out-parameter.
      const fd = call && index >= 0 ? funcdefOf(call.callee) : null;
      const documented = fd ? funcdefOutWidth(fd, index) : null;
      if (!call || index < 0 || (documented !== 4 && (!o.argReach || callNeedsFrame(call, index, v, o.argReach, () => 4, undefined, o.computedArgReach)))) {
        bad = true;
        why = !call || index < 0 ? 'not a call argument'
          : `handed to ${calleeSpelling(call) ?? (fd ? `a ${fd}` : 'a computed callee')} whose reach is not one word`;
        return x;
      }
      const ph = Expr.assign(Expr.identifier(v) as unknown as Expression, Expr.intLiteral(0) as unknown as Expression, '+=') as unknown as Expression;
      placeholders.set(ph, node as unknown as Expression);
      const callee = calleeSpelling(call);
      // `&v` is never null: a store the callee guards with its own null test is made.
      const width = documented !== null ? documented : !callee ? null
        : o.outParamWidthNonNull ? o.outParamWidthNonNull(callee, index)
        : o.outParamWidth ? o.outParamWidth(callee, index) : null;
      let cast: TypeNode | null = null;
      for (let j = chain.length - 1; j > i; j--) {
        if (chain[j].kind === NodeKind.CStyleCastExpr) { cast = (chain[j] as CStyleCastExpr).type; break; }
      }
      casts.set(ph, cast);
      if (width !== null && width >= 4) outs.add(ph);
      return ph;
    }
    const next = [...chain, node];
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(node)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type' || !val || typeof val !== 'object') continue;
      const r = visit(val, next);
      if (r !== val) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
    }
    return copy ?? x;
  };
  const out = visit(statements, []) as Statement[];
  return bad ? { why } : { statements: out, placeholders, outs, casts };
}

/** Put each `&v` back where its placeholder stands. */
function restoreAddresses(statements: Statement[], placeholders: ReadonlyMap<object, Expression>): Statement[] {
  if (placeholders.size === 0) return statements;
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let ch = false;
      const out = x.map(i => { const r = visit(i); if (r !== i) ch = true; return r; });
      return ch ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const back = placeholders.get(x);
    if (back) return back;
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(x as object)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type' || !val || typeof val !== 'object') continue;
      const r = visit(val);
      if (r !== val) { copy = copy ?? { ...(x as object) } as Record<string, unknown>; copy[k] = r; }
    }
    return copy ?? x;
  };
  return visit(statements) as Statement[];
}

/**
 * Whether every mention of `v` in a node's expressions other than the placeholder's own is
 * inside the arguments of the call the placeholder is an argument of (through casts and
 * parentheses): `f(v->a, v, (T *)&v)`. A call's arguments are evaluated before its body runs.
 */
function mentionsOnlyInArguments(own: Expression[], placeholder: object, v: string, mentions: number): boolean {
  let call: CallExpr | null = null;
  for (const e of own) {
    for (const c of findNodesByKind(e as unknown as ASTNode, NodeKind.CallExpr) as CallExpr[]) {
      for (const a of c.arguments) {
        let x: Expression = a;
        while (x.kind === NodeKind.ParenExpr || x.kind === NodeKind.CStyleCastExpr) {
          x = x.kind === NodeKind.ParenExpr ? (x as unknown as { expression: Expression }).expression : (x as CStyleCastExpr).expression;
        }
        if (x === placeholder) call = c;
      }
    }
  }
  if (!call) return false;
  const placeholderId = (placeholder as AssignExpr).left as unknown as ASTNode;
  let inArgs = 0;
  for (const a of call.arguments) {
    for (const id of findNodesByKind(a as unknown as ASTNode, NodeKind.Identifier)) {
      if (id !== placeholderId && (id as Identifier).name === v) inArgs++;
    }
  }
  return inArgs > 0 && inArgs === mentions - 1;
}

/** `5`, `-1`, `0xffffffff`: an integer literal, possibly negated; null otherwise. */
function literalOf(e: Expression): Expression | null {
  const u = unwrapParens(e);
  if (u.kind === NodeKind.IntegerLiteral) return u;
  if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '-' && unwrapParens((u as UnaryExpr).operand).kind === NodeKind.IntegerLiteral) return u;
  return null;
}

interface Web {
  defs: number[];
  reads: number[];
}

/**
 * `v`'s slot as a union: `union v_u { DT n; T1 L1; ... };` declared first in the body (with
 * an assertion that it is one 4-byte word on the 32-bit target), v declared with it where
 * v was declared, and every reference to v or to a life's local `Li` spelled `v.n` / `v.Li`.
 * The union keeps v's name, so the frame slot Ghidra names v is still this variable for
 * frame-group-locals; every member is the slot's bytes on the 32-bit target, so a read of
 * any of them sees what a callee reaching the slot wrote, as the shared variable did.
 */
function slotUnion(statements: Statement[], v: string, declaredType: TypeNode,
  lives: { name: string; type: TypeNode }[], taken: Set<string>): Statement[] {
  let typeName = `${v}_u`;
  for (let i = 2; taken.has(typeName); i++) typeName = `${v}_u${i}`;
  taken.add(typeName);
  // The declared type's member gets a name of its own: a member named v would be a second
  // declaration of v to every pass that counts them.
  const own = valueLocalName(spellingOf(declaredType), v, taken);
  taken.add(own);
  const memberOf = new Map<string, string>([[v, own], ...lives.map(l => [l.name, l.name] as [string, string])]);
  // Every reference to a member name, outside the positions where an identifier names a
  // member, a label, a type or a declaration.
  const NAMING = new Set(['member', 'label', 'name']);
  const visit = (x: unknown, key: string): unknown => {
    if (Array.isArray(x)) {
      let ch = false;
      const out = x.map(i => { const r = visit(i, key); if (r !== i) ch = true; return r; });
      return ch ? out : x;
    }
    if (!x || typeof x !== 'object') return x;
    const n = x as ASTNode;
    if (n.kind === NodeKind.Identifier) {
      const name = (n as Identifier).name;
      if (NAMING.has(key) || !memberOf.has(name)) return x;
      return Expr.member(Expr.identifier(v) as unknown as Expression, memberOf.get(name)!, false);
    }
    // A declaration of v is the union's; the lives' locals were never declared.
    if (n.kind === NodeKind.VariableDecl && (n as VariableDecl).name.name === v) {
      return { ...(n as VariableDecl), type: Type.typedef(typeName) };
    }
    if (n.kind === NodeKind.TypedefType || n.kind === NodeKind.ElaboratedType) return x;
    let copy: Record<string, unknown> | null = null;
    for (const [k, val] of Object.entries(n)) {
      if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type' || !val || typeof val !== 'object') continue;
      const r = visit(val, k);
      if (r !== val) { copy = copy ?? { ...(n as object) } as Record<string, unknown>; copy[k] = r; }
    }
    return copy ?? x;
  };
  const renamed = visit(statements, '') as Statement[];
  const union = {
    kind: NodeKind.UnionDecl,
    name: Expr.identifier(typeName),
    members: [Decl.field(own, declaredType), ...lives.map(l => Decl.field(l.name, l.type))],
    attributes: [],
    location: (statements[0] ?? {}).location,
    leadingTrivia: [{ kind: TriviaKind.LineComment, text: `// The values VC8 kept in ${v}'s one frame slot, one member each: a frame object reaches the slot.`, location: (statements[0] ?? {}).location }],
    trailingTrivia: [],
  } as unknown as UnionDecl;
  const message = Expr.stringLiteral(`${typeName} must stay one 4-byte frame slot`);
  const assert = {
    kind: NodeKind.StaticAssertDecl,
    condition: Expr.binary(
      Expr.binary(Expr.sizeof(Type.pointer(Type.void()), true), '!=', Expr.intLiteral(4)),
      '||',
      Expr.binary(Expr.sizeof(Type.typedef(typeName), true), '==', Expr.intLiteral(4))),
    message,
    location: message.location,
    leadingTrivia: [],
    trailingTrivia: [],
  } as unknown as StaticAssertDecl;
  return [Stmt.declStmt([union as never]) as unknown as Statement, Stmt.declStmt([assert as never]) as unknown as Statement, ...renamed];
}

export function splitLives(fn: FunctionDecl, o: SplitLivesOptions): Statement[] | null {
  const body = fn.body as CompoundStmt | undefined;
  if (!body) return null;
  const fnName = o.reportName ?? (fn.name as { name?: string })?.name ?? '?';
  const report = (line: string) => o.onReport?.(fnName, line);
  const params = fn.parameters.map(p => p as ParameterDecl).filter(p => p.name);
  const returnType = (fn as unknown as { returnType?: TypeNode }).returnType ?? null;
  let statements = body.statements as Statement[];

  // Candidates: parameters and top-level locals of a word type, each name declared once.
  const declCount = new Map<string, number>();
  const types = new Map<string, TypeNode>();
  for (const p of params) { declCount.set(p.name!.name, (declCount.get(p.name!.name) ?? 0) + 1); types.set(p.name!.name, p.type); }
  for (const d of findNodesByKind(body, NodeKind.VariableDecl)) {
    const v = d as VariableDecl;
    declCount.set(v.name.name, (declCount.get(v.name.name) ?? 0) + 1);
    types.set(v.name.name, v.type);
  }
  const topLocals = new Map<string, VariableDecl>();
  for (const st of statements) {
    if (st.kind !== NodeKind.DeclStmt) break;
    for (const d of (st as DeclStmt).declarations) {
      if (d.kind === NodeKind.VariableDecl && !(d as VariableDecl).initializer) topLocals.set((d as VariableDecl).name.name, d as VariableDecl);
    }
  }
  const candidates: string[] = [];
  for (const name of [...params.map(p => p.name!.name), ...topLocals.keys()]) {
    if (declCount.get(name) !== 1) { report(`${name}: other: declared ${declCount.get(name)} times`); continue; }
    const t = spellingOf(types.get(name)!);
    if (!declaredClassOf(t) || /\bcode\b/.test(t)) { report(`${name}: other: type ${t}`); continue; }
    candidates.push(name);
  }
  if (o.onReport) {
    const considered = new Set([...params.map(p => p.name!.name), ...topLocals.keys()]);
    for (const name of declCount.keys()) if (!considered.has(name)) report(`${name}: other: not declared bare at the top of the body`);
  }
  if (candidates.length === 0) return null;

  const declared = new Set<string>(declCount.keys());
  /** Names declared as a pointer, each once: a subscript store through one does not write it. */
  const pointers = new Set<string>([...types].filter(([n, t]) => declCount.get(n) === 1 && declaredClassOf(spellingOf(t)) === 'ptr').map(([n]) => n));
  const localTypes = new Map<string, TypeNode>(types);
  const { members, why: memberWhy } = frameReach(body, o.slots ?? [], o);
  const argAreaNamed = findNodesByKind(body as unknown as ASTNode, NodeKind.Identifier)
    .some(id => { const at = stackNameOffset((id as Identifier).name); return at !== null && at >= 0; });
  const taken = namesIn(body as unknown as ASTNode);
  for (const p of params) taken.add(p.name!.name);
  const enumConstants = new Set(o.enumConstants ?? []);
  const evidentOptions = o as ReusedParamSlotOptions;
  /** The function-pointer type a computed callee (`(*pfn)`, `pfn`) is declared with. */
  const funcdefOf = (callee: Expression): string | null => {
    let x = unwrapParens(callee);
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '*') x = unwrapParens((x as UnaryExpr).operand);
    if (x.kind !== NodeKind.Identifier) return null;
    const t = localTypes.get((x as Identifier).name);
    // Ghidra declares a pointer to the function type (`D3DVB_Lock *`); the emitted header
    // spells the funcdef as the pointer type itself.
    return t ? spellingOf(t).replace(/\s*\*$/, '') : null;
  };
  /**
   * Whether an integer expression computes an address: `&x`, an integer cast of `&x` or of
   * a pointer, or a sum or difference with one of those.
   */
  const addressValued = (e: Expression): boolean => {
    const x = unwrapParens(e);
    if (x.kind === NodeKind.UnaryExpr && (x as UnaryExpr).operator === '&') return true;
    if (x.kind === NodeKind.CStyleCastExpr) {
      if (classOf(spellingOf((x as CStyleCastExpr).type)) !== 'int') return false;
      const inner = unwrapParens((x as CStyleCastExpr).expression);
      if (inner.kind === NodeKind.UnaryExpr && (inner as UnaryExpr).operator === '&') return true;
      const t = evidentType(inner, evidentOptions, localTypes);
      return !!t && classOf(spellingOf(t)) === 'ptr';
    }
    if (x.kind === NodeKind.BinaryExpr && ((x as BinaryExpr).operator === '+' || (x as BinaryExpr).operator === '-')) {
      const b = x as BinaryExpr;
      return addressValued(b.left) || (b.operator === '+' && addressValued(b.right));
    }
    return false;
  };
  /** The locals this pass made, each a life it moved. */
  const splitLocals = new Set<string>();
  /** An expression whose value is a pointer: `&x`, or of an evident pointer type. */
  const pointerValued = (e: Expression): boolean => {
    if (isAddressOf(e)) return true;
    const u = unwrapParens(e);
    // `p + n`, `p - n` with p a pointer; `p - q` of two pointers is a distance.
    if (u.kind === NodeKind.BinaryExpr && ((u as BinaryExpr).operator === '+' || (u as BinaryExpr).operator === '-')) {
      const b = u as BinaryExpr;
      return b.operator === '+' ? pointerValued(b.left) || pointerValued(b.right) : pointerValued(b.left) && !pointerValued(b.right);
    }
    const t = evidentType(e, evidentOptions, localTypes);
    return !!t && (wordClass(spellingOf(t)) === 'ptr' || /\]\s*$/.test(spellingOf(t)));
  };
  /** The size of a type on the 32-bit target, from its spelling and the aggregate sizes. */
  const sizeOfType = (t: string): number | null => {
    const x = t.trim();
    const arr = /^(.*?)\s*\[\s*(\w+)\s*\]$/.exec(x);
    if (arr) {
      const e = sizeOfType(arr[1]);
      const n = Number(arr[2]);
      return e !== null && Number.isInteger(n) ? e * n : null;
    }
    if (/\*$/.test(x)) return 4;
    return pointeeSize(`${x} *`) ?? GHIDRA_SIZES[x] ?? o.aggregateSizes?.[aggregateName(x)] ?? null;
  };
  /**
   * A member path rooted at `v` (`v->a.b[2]`, `v[-1].f`), read through v's declared pointer
   * type: its byte offset from v's value and its Ghidra type. Null where a step is unknown
   * (a bit field, a field the layout lacks, an index that is not a literal).
   */
  const memberPath = (x: Expression, v: string, dt: string): { offset: number; type: string } | null => {
    const u = unwrapParens(x);
    if (u.kind === NodeKind.MemberExpr) {
      const m = u as unknown as { object: Expression; member: ASTNode; isArrow: boolean };
      if (m.member.kind !== NodeKind.Identifier) return null;
      let base: { offset: number; type: string } | null;
      if (m.isArrow) {
        // `v->f`, or `((T *)v)->f` through another pointer type.
        const ob = unwrapParens(m.object);
        const through = ob.kind === NodeKind.CStyleCastExpr && isIdent((ob as CStyleCastExpr).expression, v)
          && /\*\s*$/.test(spellingOf((ob as CStyleCastExpr).type)) ? spellingOf((ob as CStyleCastExpr).type) : null;
        base = isIdent(ob, v) ? { offset: 0, type: aggregateName(dt) } : through ? { offset: 0, type: aggregateName(through) } : null;
      }
      else base = memberPath(m.object, v, dt);
      if (!base || /[*\]]\s*$/.test(base.type)) return null;
      const f = o.structLayouts?.[aggregateName(base.type)]?.find(x => x.name === (m.member as Identifier).name);
      if (!f || f.bitSize !== undefined) return null;
      return { offset: base.offset + f.offset, type: f.type };
    }
    if (u.kind === NodeKind.SubscriptExpr) {
      const sx = u as unknown as { array: Expression; index: Expression };
      const k = literalValue(sx.index);
      if (k === null) return null;
      if (isIdent(sx.array, v)) {
        const pointee = aggregateName(dt);
        const size = sizeOfType(pointee);
        return size === null ? null : { offset: Number(k) * size, type: pointee };
      }
      const base = memberPath(sx.array, v, dt);
      const arr = base && /^(.*?)\s*\[\s*\w+\s*\]$/.exec(base.type);
      const size = arr ? sizeOfType(arr[1]) : null;
      return base && arr && size !== null ? { offset: base.offset + Number(k) * size, type: arr[1] } : null;
    }
    return null;
  };
  /**
   * The member addresses through `v` an integer cast takes as a number: `(int)&v->f`,
   * `(int)v->abBuf` (an array member decays to its address), and - where the address goes
   * through byte arithmetic to the cast, `(int)(v->abBuf + n - 0x19)` - those of one-byte
   * steps. Each node and its offset from v; an integer life reads it as `n + offset`.
   */
  const interiorAddresses = (exprs: Expression[], v: string, dt: string): Map<object, { offset: number; cast: CStyleCastExpr | null }> => {
    const out = new Map<object, { offset: number; cast: CStyleCastExpr | null }>();
    let cast: CStyleCastExpr | null = null;
    const visit = (e: Expression, depth: number): void => {
      const u = unwrapParens(e);
      if (u.kind === NodeKind.UnaryExpr && (u as UnaryExpr).operator === '&') {
        const p = memberPath((u as UnaryExpr).operand, v, dt);
        if (p && (depth === 0 || sizeOfType(p.type) === 1)) out.set(u, { offset: p.offset, cast: depth === 0 ? cast : null });
        return;
      }
      if (u.kind === NodeKind.MemberExpr || u.kind === NodeKind.SubscriptExpr) {
        const p = memberPath(u, v, dt);
        const arr = p && /^(.*?)\s*\[\s*\w+\s*\]$/.exec(p.type);
        if (p && arr && (depth === 0 || sizeOfType(arr[1]) === 1)) out.set(u, { offset: p.offset, cast: depth === 0 ? cast : null });
        return;
      }
      if (u.kind === NodeKind.BinaryExpr) {
        const b = u as BinaryExpr;
        if (b.operator === '+') {
          if (!pointerValued(b.right) || !pointerValued(b.left)) { visit(b.left, depth + 1); visit(b.right, depth + 1); }
        } else if (b.operator === '-' && !pointerValued(b.right)) visit(b.left, depth + 1);
      }
    };
    for (const e of exprs) {
      for (const c of findNodesByKind(e as unknown as ASTNode, NodeKind.CStyleCastExpr) as CStyleCastExpr[]) {
        if (classOf(spellingOf(c.type)) === 'int') { cast = c; visit(c.expression, 0); }
      }
    }
    return out;
  };
  /** What one step of a pointer spelled `p` moves, in bytes: the size of what it points at. */
  const elementSize = (p: string): number | null => (/^[^()]*\*\s*$/.test(p) ? sizeOfType(p.replace(/\s*\*\s*$/, '')) : null);
  let changed = false;

  // A split retypes what it moves, and a variable refused before it may have read or stored
  // exactly that value (`p = q;` with q's life now an integer): every candidate is looked at
  // again while a round still splits. Each round is the same proof on the current body.
  for (let round = 0; round < 4; round++) {
    let splitThisRound = false;
    for (const v of candidates) {
      if (!declared.has(v)) continue;
      let overlay = false;
      const proxied = callScopedAddresses(statements, v, o, funcdefOf);
      if ('why' in proxied) { report(`${v}: refused: its address leaves the frame: ${proxied.why}`); continue; }
      const work = proxied.statements;
      const placeholders = proxied.placeholders;
      const outs = proxied.outs;
      const addressCasts = proxied.casts;
      /** The `v` of each placeholder `v += 0`: not a read of its own. */
      const placeholderIds = new Set<object>([...placeholders.keys()].map(ph => (ph as unknown as AssignExpr).left));
      // Conditions as short-circuit nodes: a value stored in `a || (v = f(), v == 0)` is a
      // whole write on the paths that evaluate it, and reaches only those.
      // `p[i] = x` stores through a pointer: a read of p, not a write.
      const flow = buildFunctionFlow(work, declared, { shortCircuitConditions: true, pointers });
      if (flow.isEscaped(v)) { report(`${v}: other: escaped`); continue; }
      if (!topLocals.has(v) && argAreaNamed) {
        // The argument area read by offset (`stack0x00000008`) may be this parameter's word.
        report(`${v}: refused: the argument area is named by offset`);
        continue;
      }
      if (topLocals.has(v)) {
        const slot = (o.slots ?? []).find(x => x.name === v && !x.isParameter);
        // A name the frame does not carry but whose auto-name encodes a frame position is a
        // piece of another slot, which frame-group-locals lays out with it.
        if (!slot && frameAliasOffset(v) !== null) { report(`${v}: refused: a piece of a frame slot`); continue; }
        if (members.has(v)) {
          const from = members.get(v)!;
          const why = `a frame object may hold its slot (from ${from}${memberWhy.has(from) ? `: ${memberWhy.get(from)}` : ''})`;
          if (!o.slotUnions) { report(`${v}: refused: ${why}`); continue; }
          const slot = (o.slots ?? []).find(x => x.name === v && !x.isParameter);
          if (!slot || slot.size !== 4) { report(`${v}: refused: ${why}, and its slot is not one 4-byte word`); continue; }
          overlay = true;
        }
      }
      const declaredType = types.get(v)!;
      const dt = spellingOf(declaredType);
      /** v's lives become members of a union in its slot rather than locals of their own. */
      const dtClass = declaredClassOf(dt)!;

      // The writes, each a whole statement.
      const writes = new Map<number, Write>();
      // A declaration without an initializer holds the same indeterminate value as entry.
      const bareDecls: number[] = [];
      let odd = false;
      let oddAt = '';
      for (const n of flow.cfg.nodes) {
        if (!flow.writes(n.id).has(v)) continue;
        if (n.stmt?.kind === NodeKind.DeclStmt && (n.stmt as DeclStmt).declarations.some(d =>
          d.kind === NodeKind.VariableDecl && (d as VariableDecl).name.name === v && !(d as VariableDecl).initializer)) {
          bareDecls.push(n.id);
          continue;
        }
        if (placeholders.size > 0) {
          // A call handed `&v`: every write of v the node makes must be such a call's.
          const own = flow.ownExprs(n.id);
          const kinds = (k: NodeKind) => own.flatMap(e => findNodesByKind(e as unknown as ASTNode, k));
          const touches = kinds(NodeKind.AssignExpr).filter(a => placeholders.has(a)).length;
          if (touches > 0) {
            const all = kinds(NodeKind.AssignExpr).filter(a => isIdent((a as AssignExpr).left, v)).length
              + [...kinds(NodeKind.UnaryExpr), ...kinds(NodeKind.PostfixExpr)]
                .filter(u => ((u as UnaryExpr).operator === '++' || (u as UnaryExpr).operator === '--') && isIdent((u as UnaryExpr).operand, v)).length;
            if (all !== touches) { odd = true; break; }
            const handed = kinds(NodeKind.AssignExpr).filter(a => placeholders.has(a));
            const mentions = kinds(NodeKind.Identifier).filter(id => (id as Identifier).name === v).length;
            // One out-parameter call, and v named nowhere else in the node: a fresh value.
            const castType = touches === 1 ? addressCasts.get(handed[0]) ?? undefined : undefined;
            if (touches === 1 && outs.has(handed[0]) && mentions === 1) {
              writes.set(n.id, { node: n.id, expr: own[0], kind: 'out', placeholder: handed[0] as unknown as Expression, castType });
              continue;
            }
            // `f(v->a, (T *)&v)`: v's other mentions are all arguments of the call that is
            // handed its address, evaluated before the call runs. They read the value v had;
            // the call's store begins a new one.
            if (touches === 1 && outs.has(handed[0]) && mentionsOnlyInArguments(own, handed[0], v, mentions)) {
              writes.set(n.id, { node: n.id, expr: own[0], kind: 'out', placeholder: handed[0] as unknown as Expression, castType, readsBefore: true });
              continue;
            }
            writes.set(n.id, { node: n.id, expr: own[0], kind: 'touch', placeholder: touches === 1 ? handed[0] as unknown as Expression : undefined, castType });
            continue;
          }
        }
        const w = wholeWrite(flow, n.id, v) ?? nestedWrite(flow, n.id, v);
        if (!w) {
          odd = true;
          if (o.onReport) {
            const own = flow.ownExprs(n.id);
            try { oddAt = own.map(e => emit(e as never)).join(' ; ').replace(/\s+/g, ' ').slice(0, 120); } catch { oddAt = '?'; }
          }
          break;
        }
        writes.set(n.id, w);
      }
      if (odd) { report(`${v}: refused: written inside an expression: ${oddAt}`); continue; }
      if (writes.size === 0) { report(`${v}: single: never stored`); continue; }

      // The webs: a read joins every definition that reaches it; an update joins its own
      // definition to the ones it reads.
      const uf = new UnionFind();
      uf.find(ENTRY_DEF);
      for (const id of bareDecls) uf.union(id, ENTRY_DEF);
      for (const id of writes.keys()) uf.find(id);
      const readNodes: number[] = [];
      let unreached = false;
      for (const n of flow.cfg.nodes) {
        if (!flow.reads(n.id).has(v)) continue;
        // The placeholder reads v for the dataflow; an out-parameter call does not, though
        // its other arguments may (the value before the call).
        const outW = writes.get(n.id);
        if (outW?.kind === 'out' && !outW.readsBefore) continue;
        const reach = [...flow.reaching(n.id, v)];
        if (reach.length === 0) { unreached = true; break; }
        for (let i = 1; i < reach.length; i++) uf.union(reach[0], reach[i]);
        const w = writes.get(n.id);
        // An update, and an assignment stepping the value it reads (`v = v + 4`), continue
        // the value they read: one life.
        if (w && (w.kind === 'compound' || w.kind === 'touch' || (w.kind === 'assign' && selfStep(w, v, spellingOf(types.get(v)!), pointerValued)))) uf.union(reach[0], n.id);
        readNodes.push(n.id);
      }
      if (unreached) { report(`${v}: refused: a read no definition reaches`); continue; }
      const webs = new Map<number, Web>();
      const webOf = (d: number): Web => {
        const r = uf.find(d);
        let w = webs.get(r);
        if (!w) { w = { defs: [], reads: [] }; webs.set(r, w); }
        return w;
      };
      webOf(ENTRY_DEF).defs.push(ENTRY_DEF);
      for (const id of bareDecls) webOf(id).defs.push(id);
      for (const id of writes.keys()) webOf(id).defs.push(id);
      for (const n of readNodes) webOf([...flow.reaching(n, v)][0]).reads.push(n);
      const entryRoot = uf.find(ENTRY_DEF);

      // Every read occurrence in a node, with the cast directly around it and, for an uncast
      // read, the type of where its value goes. The left side of the node's own assignment is
      // a write, not a read.
      const occurrencesIn = (node: number): Occurrence[] => {
        const w = writes.get(node);
        const lhs = w && w.kind === 'assign' ? unwrapParens((w.expr as AssignExpr).left) : null;
        const out: Occurrence[] = [];
        /** A literal, possibly negated, possibly cast: a constant to compare with. */
        const constant = (e: Expression): boolean => {
          let u = unwrapParens(e);
          if (u.kind === NodeKind.CStyleCastExpr) u = unwrapParens((u as CStyleCastExpr).expression);
          return literalOf(u) !== null;
        };
        /**
         * `(DT)n` with n an integer: the other side of a comparison an integer life makes as
         * `n == m`, the same 32 bits either way.
         */
        const numberAsDt = (e: Expression): boolean => {
          const u = unwrapParens(e);
          if (u.kind !== NodeKind.CStyleCastExpr || !sameType(spellingOf((u as CStyleCastExpr).type), dt)) return false;
          const n = unwrapParens((u as CStyleCastExpr).expression);
          if (n.kind === NodeKind.Identifier && !localTypes.has((n as Identifier).name)) {
            const g = lookupName(o.globalTypes, (n as Identifier).name);
            return !!g && classOf(g) === 'int';
          }
          return isNumber(valueClass(n, evidentOptions, localTypes, enumConstants));
        };
        const interior = dtClass === 'ptr' ? interiorAddresses(flow.ownExprs(node), v, dt) : new Map<object, { offset: number; cast: CStyleCastExpr | null }>();
        const walk = (x: unknown, cast: CStyleCastExpr | null, offset: CStyleCastExpr | null, sink: TypeNode | null,
          truth = false, eqWith: Expression | null = null): void => {
          if (Array.isArray(x)) { for (const i of x) walk(i, null, null, null); return; }
          if (!x || typeof x !== 'object') return;
          const node = x as ASTNode;
          if (interior.has(node)) {
            const id = findNodesByKind(node, NodeKind.Identifier).find(i => (i as Identifier).name === v) as Identifier;
            out.push({ id, cast: null, offset: null, via: null, sink: null, truth: false, eqWith: null, interior: { node, ...interior.get(node)! } });
            return;
          }
          if (node.kind === NodeKind.Identifier) {
            if ((node as Identifier).name === v && node !== lhs && !placeholderIds.has(node)) {
              const bare = !cast && !offset;
              out.push({
                id: node as Identifier, cast, offset: cast ? null : offset,
                via: cast && offset && classOf(spellingOf(cast.type)) === 'int' ? offset : null,
                sink: bare ? sink : null,
                truth: bare && truth,
                eqWith: bare ? eqWith : null,
              });
            }
            return;
          }
          if (node.kind === NodeKind.UnaryExpr && (node as UnaryExpr).operator === '!') {
            walk((node as UnaryExpr).operand, null, null, null, true);
            return;
          }
          if (!offset && node.kind === NodeKind.BinaryExpr) {
            const b = node as BinaryExpr;
            if (b.operator === '&&' || b.operator === '||') {
              walk(b.left, null, null, null, true);
              walk(b.right, null, null, null, true);
              return;
            }
            if (dtClass === 'ptr' && ['<', '<=', '>', '>='].includes(b.operator) && (constant(b.left) || constant(b.right))) {
              const [mine, other] = constant(b.right) ? [b.left, b.right] : [b.right, b.left];
              if (isIdent(mine, v) && unwrapParens(mine) === mine) {
                out.push({ id: mine as Identifier, cast: null, offset: null, via: null, sink: null, truth: false, eqWith: null, relWith: other });
                walk(other, null, null, null);
                return;
              }
            }
            if (b.operator === '==' || b.operator === '!=') {
              const zero = (e: Expression) => { const u = unwrapParens(e); return u.kind === NodeKind.IntegerLiteral && (u as unknown as { value: bigint }).value === 0n; };
              walk(b.left, null, null, null, zero(b.right), constant(b.right) || numberAsDt(b.right) ? b.right : null);
              walk(b.right, null, null, null, zero(b.left), constant(b.left) || numberAsDt(b.left) ? b.left : null);
              return;
            }
          }
          if (node.kind === NodeKind.ConditionalExpr) {
            const c = node as unknown as { condition: Expression; thenExpr: Expression; elseExpr: Expression };
            walk(c.condition, null, null, null, true);
            walk(c.thenExpr, null, null, null);
            walk(c.elseExpr, null, null, null);
            return;
          }
          if (node.kind === NodeKind.CStyleCastExpr) {
            const c = node as CStyleCastExpr;
            const cc = classOf(spellingOf(c.type));
            // The life stepping itself, `p = (DT)((int)p + 1)`, is arithmetic on its own value,
            // not an address read.
            const step = lhs !== null && c === unwrapParens((w!.expr as AssignExpr).right) && sameType(spellingOf(c.type), dt);
            // `(int)p` inside `(T *)(... + 4)` keeps the displacement it sits in.
            walk(unwrapParens(c.expression), c, step ? null : cc === 'ptr' ? c : cc === 'int' ? offset : null, null);
            return;
          }
          if (node.kind === NodeKind.ParenExpr) { walk((node as unknown as { expression: Expression }).expression, cast, offset, sink, truth, eqWith); return; }
          if (offset && node.kind === NodeKind.BinaryExpr) {
            const b = node as unknown as { operator: string; left: Expression; right: Expression };
            if (b.operator === '+' || b.operator === '-') {
              // Only a literal displacement or a scaled index (`i * 8`): `(T *)(&G + v)` indexes
              // G with v, it does not make v the address.
              const disp = (e: Expression) => {
                const u = unwrapParens(e);
                if (u.kind === NodeKind.IntegerLiteral) return true;
                if (u.kind !== NodeKind.BinaryExpr) return false;
                const m = u as unknown as { operator: string; left: Expression; right: Expression };
                return (m.operator === '*' || m.operator === '<<')
                  && (unwrapParens(m.right).kind === NodeKind.IntegerLiteral || (m.operator === '*' && unwrapParens(m.left).kind === NodeKind.IntegerLiteral));
              };
              walk(b.left, null, disp(b.right) ? offset : null, null);
              walk(b.right, null, b.operator === '+' && disp(b.left) ? offset : null, null);
              return;
            }
          }
          if (node.kind === NodeKind.CallExpr) {
            const c = node as CallExpr;
            walk(c.callee, null, null, null);
            const name = calleeName(c.callee);
            const params = name ? lookupName(o.functionParamTypes, name) : undefined;
            c.arguments.forEach((a, i) => {
              const t = params && i < params.length ? typeFromSpelling(params[i]) : null;
              walk(a, null, null, t);
            });
            return;
          }
          if (node.kind === NodeKind.AssignExpr && (node as AssignExpr).operator === '=') {
            const a = node as AssignExpr;
            walk(a.left, null, null, null);
            walk(a.right, null, null, unwrapParens(a.left) === lhs ? null : evidentType(a.left, evidentOptions, localTypes));
            return;
          }
          for (const [k, val] of Object.entries(node)) {
            if (k === 'location' || k === 'leadingTrivia' || k === 'trailingTrivia' || k === 'type') continue;
            if (val && typeof val === 'object') walk(val, null, null, null);
          }
        };
        const stmt = flow.cfg.nodes[node].stmt;
        const sk = stmt?.kind;
        const returned = sk === NodeKind.ReturnStmt && returnType ? returnType : null;
        const condition = sk === NodeKind.IfStmt || sk === NodeKind.WhileStmt || sk === NodeKind.DoWhileStmt || sk === NodeKind.ForStmt
          || flow.cfg.nodes[node].condPart === 'test';
        for (const e of flow.ownExprs(node)) walk(e, null, null, returned, condition);
        return out;
      };

      // Plan every web that moves before rewriting any.
      interface Move {
        web: Web; type: TypeNode; spelling: string; cls: WordClass; local: string;
        /** The life's own steps rewritten as arithmetic on the new type (see stepNodes). */
        steps: Map<number, { op: '+' | '-'; step: Expression | null }>;
      }
      const moves: Move[] = [];
      let laterRead = false;
      /** One key per type when deciding: the 4-byte integer spellings are one type. */
      const kind = (t: string) => lifeClass(t) === 'int' ? 'int' : t;
      /** The spelling most of `types` carry, the earliest on a tie. */
      const pick = (types: TypeNode[]): TypeNode => {
        const n = new Map<string, number>();
        for (const t of types) n.set(spellingOf(t), (n.get(spellingOf(t)) ?? 0) + 1);
        let best = types[0];
        for (const t of types) if (n.get(spellingOf(t))! > n.get(spellingOf(best))!) best = t;
        return best;
      };
      for (const [root, web] of webs) {
        if (root === entryRoot || web.reads.length === 0) continue;
        laterRead = true;
        if (web.defs.some(d => writes.get(d)?.kind === 'touch' && !writes.get(d)!.placeholder)) {
          report(`${v}: touched: one call is handed its address twice`);
          continue;
        }
        const occ = web.reads.flatMap(n => occurrencesIn(n).map(c => ({ ...c, node: n })));
        // Stores: the value each one stores, its cast to the declared type off.
        const storeTypes: (string | null)[] = [];
        const storeNodes: TypeNode[] = [];
        for (const d of web.defs) {
          const w = writes.get(d)!;
          if (w.kind === 'compound') continue;
          if (w.kind === 'out' || w.kind === 'touch') {
            // `(T *)&v` handed to a call: the call stores (or updates) a T.
            const pointee = w.castType ? (w.castType as unknown as { pointee?: TypeNode }).pointee ?? null : null;
            const ps = pointee ? spellingOf(pointee) : '';
            // `(void **)&v` says only "a pointer", which is news in an integer variable;
            // `(eD2UnitType *)&p` says an enum's integer, news in a pointer.
            const t = pointee && lifeClass(ps) && (dtClass === 'int' || !/^void\s*\*$/.test(ps)) ? pointee : null;
            storeTypes.push(t ? ps : null);
            if (t) storeNodes.push(t);
            continue;
          }
          let x = unwrapParens((w.expr as AssignExpr).right);
          if (x.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((x as CStyleCastExpr).type), dt)) x = unwrapParens((x as CStyleCastExpr).expression);
          if (isConstantStore(x, enumConstants, localTypes)) continue;
          // `v = v + 0x120`: the life stepping itself says nothing about its type. A value
          // loaded through it (`v = v->pNext`) has the type of what it loads.
          if (steps(x, v)) continue;
          const t = evidentType(x, evidentOptions, localTypes);
          // `(intptr_t)&p->f + 1`: arithmetic on an address is an address, whatever integer
          // type the arithmetic is spelled in.
          if ((!t || classOf(spellingOf(t)) === 'int') && addressValued(x)) { storeTypes.push('void*'); continue; }
          storeTypes.push(t ? spellingOf(t) : null);
          if (t) storeNodes.push(t);
        }
        // Stores of two different types meeting at one read: a join of two values. It stays
        // one variable, as the decompiler printed it.
        const storedKinds = new Set(storeTypes.filter((t): t is string => t !== null && classOf(t) !== null && !sameType(t, dt)).map(kind));
        if (storedKinds.size > 1) {
          report(`${v}: join: ${web.defs.length} stores of ${[...storedKinds].join(' | ')} reach ${web.reads.length} read nodes`);
          continue;
        }
        // How each read takes the value: cast to a pointer or an integer, or passed uncast to
        // a place of a pointer or integer type. An integer cast inside address arithmetic
        // (`via`) reads an address and votes for no type.
        const readAs = (c: Occurrence): TypeNode | null => c.cast && !c.via ? c.cast.type : !c.cast && c.sink ? c.sink : null;
        const ptrReads = occ.map(readAs).filter((t): t is TypeNode => t !== null && classOf(spellingOf(t)) === 'ptr');
        const intReads = occ.map(readAs).filter((t): t is TypeNode => t !== null && classOf(spellingOf(t)) === 'int');
        const typedStores = storeNodes.filter(t => lifeClass(spellingOf(t)) !== null);
        // A read as an enum reads an integer (the tree declares an enum as an integer type).
        const enumReads = occ.map(readAs).filter((t): t is TypeNode => t !== null && wordClass(spellingOf(t)) === 'enum');
        const storedOne = typedStores.length > 0 && storeTypes.every(t => t !== null) && new Set(typedStores.map(t => kind(spellingOf(t)))).size === 1;
        let target: TypeNode | null = null;
        let why = '';
        if (dtClass === 'int') {
          // A pointer life in an integer variable.
          const read = new Set(ptrReads.map(spellingOf));
          // A read that is a byte offset onto the value, `(T *)(v + 4)`, says the value is an
          // address, and of a T where nothing else says otherwise.
          const offsets = occ.filter(c => c.offset).map(c => c.offset!);
          const offsetTypes = new Set(offsets.map(c => spellingOf(c.type)));
          if (read.size === 1) target = ptrReads[0];
          else if (storedOne && classOf(spellingOf(typedStores[0])) === 'ptr') target = pick(typedStores);
          // An address held as an integer and read only through pointer casts at offsets,
          // `(T *)(n + 4)`: a T* life, its integer stores converted where they are stored -
          // the count below takes it only where the offsets outnumber those conversions.
          // Read at offsets as several types: a byte pointer, which each read steps from.
          else if (read.size === 0 && offsetTypes.size >= 1 && storeTypes.every(t => t === null || lifeClass(t) === 'int')) {
            target = offsetTypes.size === 1 ? offsets[0].type : Type.pointer(Type.char());
          }
          else why = read.size === 0 ? 'no read casts it to a pointer' : `read as ${read.size} pointer types, stores ${[...new Set(storeTypes)].join('|') || 'none'}`;
        } else {
          // An integer life (or a pointer to another type) in a pointer variable.
          const readPtrs = new Set(ptrReads.map(spellingOf).filter(s => !sameType(s, dt)));
          const ptrCastCount = occ.filter(c => c.cast && !c.via && classOf(spellingOf(c.cast.type)) === 'ptr').length;
          if (intReads.length + enumReads.length > 0 && readPtrs.size === 0 && ptrCastCount === 0) {
            // An enum the stores put there and the reads take, or the integer reads' type.
            target = storedOne && lifeClass(spellingOf(typedStores[0])) === 'int' && wordClass(spellingOf(typedStores[0])) === 'enum'
              ? pick(typedStores) : pick(intReads.length > 0 ? intReads : enumReads);
          }
          else if (readPtrs.size === 1 && intReads.length === 0) target = ptrReads.find(t => !sameType(spellingOf(t), dt))!;
          else if (storedOne && !sameType(spellingOf(typedStores[0]), dt)) target = pick(typedStores);
          else why = `reads ${[...new Set([...intReads, ...ptrReads].map(spellingOf))].join('|') || 'uncast'}, stores ${[...new Set(storeTypes)].join('|') || 'none'}`;
        }
        if (!target) {
          const stored = new Set(storeTypes.filter(s => s !== null));
          const join = web.defs.length > 1 && stored.size > 1;
          report(`${v}: ${join ? 'join' : 'untyped'}: ${web.defs.length} stores, ${occ.length} reads: ${why}`);
          continue;
        }
        const spelling = spellingOf(target);
        const cls = lifeClass(spelling);
        if (!cls || /\bcode\b/.test(spelling) || /\bundefined\b/.test(spelling) || sameType(spelling, dt)) { report(`${v}: same: its life reads as ${spelling}`); continue; }
        if (cls === 'int' && dtClass === 'int') { report(`${v}: same: an integer life in an integer`); continue; }
        // A life that stores a pointer is a pointer life, whatever its reads cast it to: an
        // integer local would hold an address in an int, which truncates it where a pointer
        // is wider than an int.
        if (cls === 'int' && storeTypes.some(t => t !== null && classOf(t) === 'ptr')) {
          report(`${v}: pointer: a store into it is a pointer, so it stays ${spellingOf(declaredType)}`);
          continue;
        }

        // The life's own steps that move with it as arithmetic on the new type, with no
        // integer between: a pointer life in an integer steps its address in bytes, an
        // integer life in a pointer steps its number by the bytes the pointer stepped. An
        // assignment's step reads only this life (every definition reaching it is one of the
        // web's), so the new local is both its sides.
        const stepNodes = new Map<number, { op: '+' | '-'; step: Expression | null }>();
        const dtPointee = dtClass === 'ptr' ? elementSize(dt) : null;
        for (const d of web.defs) {
          const w = writes.get(d)!;
          const st = selfStep(w, v, dt, pointerValued);
          if (!st) continue;
          if (w.kind === 'assign' && ![...flow.reaching(d, v)].every(r => web.defs.includes(r))) continue;
          if (cls === 'ptr' && dtClass === 'int' && !/[()[\]]/.test(spelling)) stepNodes.set(d, st);
          else if (cls === 'int' && dtClass === 'ptr' && dtPointee !== null
            && (dtPointee === 1 || st.step === null || literalOf(st.step) !== null)) stepNodes.set(d, st);
        }

        // Width casts the move removes and the ones it needs.
        let gain = 0, cost = 0;
        /** Each read and store that changed the count, for the report of a life kept. */
        const items: string[] = [];
        for (const c of occ) {
          const gb = gain, cb = cost;
          try {
          // A step's own read is part of the step, rewritten whole; so is an update's.
          if (stepNodes.has(c.node) || writes.get(c.node)?.kind === 'compound') continue;
          // A member address an integer cast takes: the integer life's own number plus the offset.
          if (c.interior && cls === 'int') { gain++; continue; }
          // An unsigned comparison with a constant: the constant's pointer cast goes.
          if (c.relWith) {
            if (cls === 'int') { const u = unwrapParens(c.relWith); if (u.kind === NodeKind.CStyleCastExpr && literalValue((u as CStyleCastExpr).expression) !== 0n) gain++; }
            else if (cls !== dtClass) cost++;
            continue;
          }
          if (c.offset && cls === 'ptr' && dtClass === 'int') { gain++; continue; }
          // Address arithmetic through an integer: a pointer life keeps it as it is, an
          // integer one turns its pointer cast into an integer-to-pointer one.
          if (c.via) { if (cls === 'int') cost++; continue; }
          const cc = c.cast ? classOf(spellingOf(c.cast.type)) : null;
          if (!c.cast && !c.offset && (c.truth || (c.eqWith && cls === 'int'))) {
            // `p == (DT)n` read by an integer life as `m == n`: the other side's cast goes.
            if (!c.truth && c.eqWith && literalOf(c.eqWith) === null && unwrapParens(c.eqWith).kind === NodeKind.CStyleCastExpr
              && literalOf((unwrapParens(c.eqWith) as CStyleCastExpr).expression) === null) gain++;
            continue;
          }
          if (!c.cast) {
            const sc = c.sink ? classOf(spellingOf(c.sink)) : null;
            if (sc === cls && cls !== dtClass) gain++;
            else if (cls !== dtClass) cost++;
            continue;
          }
          if (!cc) {
            // An enum read of an integer life converts an integer, not an address.
            if (cls === 'int' && wordClass(spellingOf(c.cast.type)) === 'enum') gain++;
            // A narrower integer read of one keeps its one cast, and it no longer truncates a
            // pointer (`(ushort)p`): the integer life reads it as an integer.
            else if (cls === 'int' && NARROW_INTEGERS.has(spellingOf(c.cast.type))) { if (dtClass === 'ptr') gain++; continue; }
            else if (cls !== dtClass) cost++;
            continue;
          }
          if (cc !== dtClass && cc === cls) gain++;
          else if (cc === dtClass && cc !== cls) cost++;
          } finally {
            if (o.onReport && (gain !== gb || cost !== cb)) {
              let t = '?'; try { t = emit((c.cast ?? c.offset ?? c.id) as never).replace(/\s+/g, ' ').slice(0, 60); } catch { /* the report only */ }
              items.push(`${gain > gb ? '+' : '-'}r[${t}]${c.sink ? ' sink ' + spellingOf(c.sink) : ''}`);
            }
          }
        }
        for (const d of web.defs) {
          const gb = gain, cb = cost;
          try {
          const w = writes.get(d)!;
          if (stepNodes.has(d)) continue;
          if (w.kind === 'compound') { if (cls !== dtClass) cost += 2; continue; }
          if (w.kind === 'out' || w.kind === 'touch') continue;
          if (w.nested?.consumed && cls !== dtClass) cost++;
          const rhs = unwrapParens((w.expr as AssignExpr).right);
          let inner: Expression | null = null;
          if (rhs.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((rhs as CStyleCastExpr).type), dt)) {
            inner = unwrapParens((rhs as CStyleCastExpr).expression);
            const t = evidentType(inner, evidentOptions, localTypes);
            // An address converted to the integer, `(int)&p->f`: a pointer, whatever its type;
            // an integer of any width is a number.
            const tc = (t ? classOf(spellingOf(t)) : null)
              ?? (dtClass === 'int' && isAddressOf(inner) ? 'ptr'
                : isNumber(valueClass(inner, evidentOptions, localTypes, enumConstants)) ? 'int' : null);
            if (tc && tc !== dtClass && tc === cls) { gain++; continue; }
          }
          // A literal is stored as the same number in the new type: no cast where it is 0 or
          // the life is an integer; a pointer life needs `(T *)` on any other.
          const lit = literalOf(inner ?? rhs);
          if (lit && cls !== dtClass) {
            const zero = (unwrapParens(lit) as unknown as { value?: bigint }).value === 0n;
            if (!zero && cls === 'int' && inner) gain++;
            else if (!zero && cls === 'ptr') cost++;
            continue;
          }
          if (cls !== dtClass && !isConstantStore(rhs, enumConstants, localTypes)) cost++;
          } finally {
            if (o.onReport && (gain !== gb || cost !== cb)) {
              let t = '?'; try { t = emit(writes.get(d)!.expr as never).replace(/\s+/g, ' ').slice(0, 60); } catch { /* the report only */ }
              items.push(`${gain > gb ? '+' : '-'}w[${t}]`);
            }
          }
        }
        // A tie moves as many casts as it removes; it is taken only when the stores prove the
        // type: every store of the life has one evident type, the life's own. The value is a
        // T because each store puts a T there, not because of how it is read. An integer life
        // is moved out of a pointer only where the slot is a parameter's, reused: a local
        // pointer whose stores are integers is a pointer an API returns in an integer type
        // (`(T *)InterlockedCompareExchange(...)`), and moving it would only move its casts.
        const canon = (t: string) => kind(t).replace(/\b(short|long) int\b/g, '$1').replace(/\bunsigned int\b/g, 'unsigned');
        const provenByStores = storedOne && canon(spellingOf(typedStores[0])) === canon(spelling)
          && (cls === 'ptr' || !topLocals.has(v));
        if (gain < cost || (gain === cost && !(gain > 0 && provenByStores))) {
          report(`${v}: kept: a ${spelling} life would remove ${gain} casts and need ${cost}${items.length ? ' :: ' + items.join(' ') : ''}`);
          continue;
        }
        const local = valueLocalName(spelling, v, taken);
        taken.add(local);
        moves.push({ web, type: target, spelling, cls, local, steps: stepNodes });
      }
      if (moves.length === 0 && !laterRead) report(`${v}: joined: every value read is the entry value`);
      if (moves.length === 0) continue;
      // A local with one value that is read is one variable of the wrong type, not several
      // sharing a slot: its type is Ghidra's to fix. A parameter's slot holding one other
      // value is the reuse itself.
      if (topLocals.has(v)) {
        const readLives = [...webs.values()].filter(w => w.reads.length > 0).length;
        // Unless every value it stores comes from a life this pass moved: the mistype is
        // then the split's, which turned the value it copies into another type.
        const fromSplit = moves.every(m => m.web.defs.every(d => {
          const w = writes.get(d)!;
          if (w.kind !== 'assign') return false;
          let x = unwrapParens((w.expr as AssignExpr).right);
          if (x.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((x as CStyleCastExpr).type), dt)) x = unwrapParens((x as CStyleCastExpr).expression);
          return isConstantStore(x, enumConstants, localTypes)
            || findNodesByKind(x as unknown as ASTNode, NodeKind.Identifier).some(id => splitLocals.has((id as Identifier).name));
        }));
        if (readLives < 2 && !fromSplit) {
          report(`${v}: single: one value is read, its type is the variable's`);
          continue;
        }
      }

      /**
       * A step of a moved life, from the rebuilt node: a pointer life steps its address -
       * by elements where the step is a multiple of what it points at, in bytes through
       * `char *` otherwise; an integer life steps its number by the bytes the declared
       * pointer stepped (its element size times the step). The same address or number as
       * the merged variable's step, and no integer-pointer conversion.
       */
      const stepRewrite = (m: Move, w: Write, rebuilt: ASTNode, ident: () => Expression): Expression => {
        const st = (rebuilt.kind === NodeKind.AssignExpr || w.kind === 'compound')
          ? selfStep({ ...w, expr: rebuilt as unknown as Expression }, v, dt, () => false) ?? m.steps.get(w.node)!
          : m.steps.get(w.node)!;
        const signed = (e: Expression | null): bigint | null => {
          if (!e) return 1n;
          const l = literalOf(e);
          if (!l) return null;
          const u = unwrapParens(l);
          if (u.kind === NodeKind.IntegerLiteral) return (u as unknown as { value: bigint }).value;
          return -((unwrapParens((u as UnaryExpr).operand) as unknown as { value: bigint }).value);
        };
        const k = signed(st.step);
        const lit = (n: bigint): Expression => (n < 0n
          ? Expr.unary('-', Expr.intLiteral(-n, -n > 9n ? 16 : 10) as unknown as Expression) as unknown as Expression
          : Expr.intLiteral(n, n > 9n ? 16 : 10) as unknown as Expression);
        const opAssign = (op: '+' | '-') => (op === '+' ? '+=' : '-=') as never;
        if (m.cls === 'ptr') {
          const size = elementSize(m.spelling);
          if (k !== null && size !== null && size > 0 && k % BigInt(size) === 0n) {
            return Expr.assign(ident(), lit(k / BigInt(size)), opAssign(st.op)) as unknown as Expression;
          }
          const bytes = Expr.cast(Type.pointer(Type.char()), ident()) as unknown as Expression;
          const step = st.step ? Expr.paren(st.step) as unknown as Expression : lit(1n);
          return Expr.assign(ident(), Expr.cast(m.type, Expr.paren(Expr.binary(bytes, st.op as never, step) as unknown as Expression) as unknown as Expression) as unknown as Expression) as unknown as Expression;
        }
        const size = BigInt(elementSize(dt)!);
        const by = k !== null ? lit(k * size) : st.step!;
        return Expr.assign(ident(), by, opAssign(st.op)) as unknown as Expression;
      };

      // The rewrite: node identity -> its replacement, built from the rebuilt children.
      const replace = new Map<object, (rebuilt: ASTNode) => Expression>();
      const castTo = (t: TypeNode, e: Expression) => Expr.paren(Expr.cast(t, e)) as unknown as Expression;
      for (const m of moves) {
        const ident = () => Expr.identifier(m.local) as unknown as Expression;
        for (const n of m.web.reads) {
          const w = writes.get(n);
          if (w && w.kind === 'compound') continue; // rewritten whole below
          if (m.steps.has(n)) continue; // so is a step
          for (const c of occurrencesIn(n)) {
            if (c.interior && m.cls === 'int') {
              const off = c.interior.offset;
              // `(int)&v->f` into an int life: the number itself, its cast to its own type gone.
              const at = c.interior.cast && sameType(spellingOf(c.interior.cast.type), m.spelling) ? c.interior.cast : c.interior.node;
              replace.set(at, () => off === 0 ? ident()
                : Expr.paren(Expr.binary(ident(), off < 0 ? '-' : '+', Expr.intLiteral(Math.abs(off), Math.abs(off) > 9 ? 16 : 10) as unknown as Expression) as unknown as Expression) as unknown as Expression);
              continue;
            }
            if (c.relWith && m.cls === 'int') {
              const u = unwrapParens(c.relWith);
              const k = u.kind === NodeKind.CStyleCastExpr ? literalOf((u as CStyleCastExpr).expression) : literalOf(u);
              const unsigned = /^(?:unsigned\b|uint|u?intptr_t$|DWORD$|UINT$|ULONG$|size_t$|uint32_t$)/.test(m.spelling.trim()) && !/^uint16|^uint8/.test(m.spelling.trim());
              replace.set(c.id, () => unsigned ? ident() : Expr.paren(Expr.cast(Type.typedef('uint32_t'), ident()) as unknown as Expression) as unknown as Expression);
              if (k) replace.set(c.relWith, () => k);
              continue;
            }
            if (!c.cast && !c.offset && c.truth) { replace.set(c.id, () => ident()); continue; }
            if (!c.cast && !c.offset && c.eqWith && m.cls === 'int') {
              // `v != (char *)0x202` -> `n != 0x202`.
              const other = unwrapParens(c.eqWith);
              const k = literalOf(other.kind === NodeKind.CStyleCastExpr ? unwrapParens((other as CStyleCastExpr).expression) : other);
              replace.set(c.id, () => ident());
              if (k) replace.set(c.eqWith, () => k);
              // `p == (DT)n` -> `m == n`: the integer the other side converted.
              else replace.set(c.eqWith, (rebuilt) => {
                const r = unwrapParens(rebuilt as unknown as Expression);
                return r.kind === NodeKind.CStyleCastExpr ? Expr.paren((r as CStyleCastExpr).expression) as unknown as Expression : rebuilt as unknown as Expression;
              });
              continue;
            }
            if (!c.cast) {
              const sink = c.sink;
              const sc = sink ? spellingOf(sink) : null;
              if (sink && sc && !c.offset && classOf(sc) === m.cls) {
                // The value goes on to a place of its own class: the local itself, converted
                // to a pointer of another type where the place's type names one.
                const plain = m.cls === 'int' || sameType(sc, m.spelling) || /^(?:const )?void\*$/.test(sc);
                replace.set(c.id, () => plain ? ident() : castTo(sink, ident()));
                continue;
              }
              // A pointer life read at a byte offset, `(T *)(v + 4)`: the bytes from its address.
              if (c.offset && m.cls === 'ptr' && dtClass === 'int') {
                const bytes = ['char*', 'unsigned char*', 'uchar*', 'uint8_t*', 'byte*', 'BYTE*'].includes(m.spelling);
                replace.set(c.id, () => bytes ? ident() : Expr.paren(Expr.cast(Type.pointer(Type.char()), ident()) as unknown as Expression) as unknown as Expression);
                continue;
              }
              // A read in the life's own step (`v = v + 2`) is integer arithmetic: through an
              // enum's int, as the compound step is.
              const stepping = w && w.kind === 'assign' && wordClass(dt) === 'enum'
                && findNodesByKind((w.expr as AssignExpr).right as unknown as ASTNode, NodeKind.Identifier).includes(c.id as unknown as ASTNode);
              replace.set(c.id, () => castTo(stepping ? Type.int() : declaredType, ident()));
              continue;
            }
            const ct = spellingOf(c.cast.type);
            const cc = classOf(ct);
            const castType = c.cast.type;
            if (sameType(ct, m.spelling)) replace.set(c.cast, () => ident());
            else if (cc === 'ptr' && m.cls === 'ptr') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            // An address as an integer is the same bits whatever the pointer's type.
            else if (cc === 'int' && m.cls === 'ptr' && dtClass === 'ptr') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            else if (cc === 'int' && m.cls === 'int') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            else if (sameType(ct, dt)) replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            else if (m.cls === 'int' && wordClass(ct) === 'enum') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            else if (m.cls === 'int' && NARROW_INTEGERS.has(ct)) replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            // An integer life read as another pointer: one conversion, not two.
            else if (cc === 'ptr' && m.cls === 'int') replace.set(c.cast, () => Expr.cast(castType, ident()) as unknown as Expression);
            else replace.set(c.cast, () => Expr.cast(castType, castTo(declaredType, ident())) as unknown as Expression);
          }
        }
        for (const d of m.web.defs) {
          const w = writes.get(d)!;
          if (m.steps.has(d)) {
            replace.set(w.expr, (rebuilt) => stepRewrite(m, w, rebuilt, ident));
            continue;
          }
          if (w.kind === 'out' || w.kind === 'touch') {
            // The call is handed the new local's address instead.
            replace.set(w.placeholder!, () => Expr.addressOf(ident()) as unknown as Expression);
            continue;
          }
          if (w.kind === 'compound') {
            const e = w.expr;
            let op: string, operand: Expression;
            if (e.kind === NodeKind.AssignExpr) { op = COMPOUND_OPS[(e as AssignExpr).operator]; operand = (e as AssignExpr).right; }
            else { op = (e as UnaryExpr).operator === '++' ? '+' : '-'; operand = Expr.intLiteral(1) as unknown as Expression; }
            const isAssign = e.kind === NodeKind.AssignExpr;
            // The step is integer arithmetic in the declared type; an enum's is an int's (MSVC
            // lays an enum out as one), and the word spelled `int` is the one pointer-word-cast
            // recognises as address arithmetic.
            const stepType = wordClass(dt) === 'enum' ? Type.int() : declaredType;
            replace.set(e, (rebuilt) => {
              const right = isAssign ? (rebuilt as AssignExpr).right : operand;
              const value = Expr.binary(castTo(stepType, ident()), op as never, Expr.paren(right) as unknown as Expression) as unknown as Expression;
              return Expr.assign(ident(), m.cls === dtClass ? value : Expr.cast(m.type, Expr.paren(value)) as unknown as Expression) as unknown as Expression;
            });
            continue;
          }
          const a = w.expr as AssignExpr;
          const rhs = unwrapParens(a.right);
          let inner: Expression | null = null;
          let innerType: string | null = null;
          if (rhs.kind === NodeKind.CStyleCastExpr && sameType(spellingOf((rhs as CStyleCastExpr).type), dt)) {
            inner = unwrapParens((rhs as CStyleCastExpr).expression);
            const t = evidentType(inner, evidentOptions, localTypes);
            innerType = t ? spellingOf(t)
              : m.cls === 'int' && isNumber(valueClass(inner, evidentOptions, localTypes, enumConstants)) ? m.spelling
              // `(int)&x` into a pointer life: the address itself, converted to the life's type.
              : m.cls === 'ptr' && isAddressOf(inner) ? 'void *' : null;
          }
          // A store whose value its expression goes on to use keeps the declared type there.
          const keep = (store: Expression): Expression => w.nested?.consumed ? castTo(declaredType, Expr.paren(store) as unknown as Expression) : store;
          replace.set(a, (rebuilt) => {
            const ra = rebuilt as AssignExpr;
            let value: Expression;
            // A literal, through the declared type's cast or bare: the same number, in the new
            // type (both are one 32-bit word).
            const lit = literalOf(inner ?? rhs);
            if (lit) {
              value = m.cls === 'int' ? lit : Expr.cast(m.type, lit) as unknown as Expression;
            } else if (inner && m.cls === 'int' && !(innerType && classOf(innerType) === 'int')
              && isNumber(valueClass(inner, evidentOptions, localTypes, enumConstants))) {
              // An integer of another width: converted to the life's type, an integer either way.
              const rc = unwrapParens(ra.right);
              const ri = rc.kind === NodeKind.CStyleCastExpr ? unwrapParens((rc as CStyleCastExpr).expression) : ra.right;
              value = Expr.cast(m.type, Expr.paren(ri) as unknown as Expression) as unknown as Expression;
            } else if (inner && innerType && classOf(innerType) === m.cls) {
              // The value the store converted to the declared type: store it as it is.
              const rc = unwrapParens(ra.right);
              if (rc.kind !== NodeKind.CStyleCastExpr) return keep(Expr.assign(ident(), Expr.cast(m.type, Expr.paren(ra.right) as unknown as Expression) as unknown as Expression) as unknown as Expression);
              const ri = unwrapParens((rc as CStyleCastExpr).expression);
              value = sameType(innerType, m.spelling) ? ri : Expr.cast(m.type, Expr.paren(ri) as unknown as Expression) as unknown as Expression;
            } else {
              value = Expr.cast(m.type, Expr.paren(ra.right) as unknown as Expression) as unknown as Expression;
            }
            return keep(Expr.assign(ident(), value) as unknown as Expression);
          });
        }
        report(`${v}: ${overlay ? 'slot union' : 'split'}: ${m.local} ${m.spelling} (${m.web.defs.length} stores, ${m.web.reads.length} read nodes)`);
      }

      const rebuild = (x: unknown): unknown => {
        if (Array.isArray(x)) {
          let ch = false;
          const out = x.map(i => { const r = rebuild(i); if (r !== i) ch = true; return r; });
          return ch ? out : x;
        }
        if (!x || typeof x !== 'object') return x;
        const node = x as ASTNode;
        let copy: Record<string, unknown> | null = null;
        for (const [k, val] of Object.entries(node)) {
          if (k === 'location' || k === 'type' || !val || typeof val !== 'object') continue;
          const r = rebuild(val);
          if (r !== val) { copy = copy ?? { ...(node as object) } as Record<string, unknown>; copy[k] = r; }
        }
        const out = (copy ?? node) as ASTNode;
        const f = replace.get(node);
        return f ? f(out) : out;
      };
      let rewritten = restoreAddresses(rebuild(work) as Statement[], placeholders);

      if (overlay) {
        statements = slotUnion(rewritten, v, declaredType, moves.map(m => ({ name: m.local, type: m.type })), taken);
        // The lives are members now, no longer names another variable's evidence can use.
        declared.delete(v);
        changed = true;
        splitThisRound = true;
        continue;
      }
      // A local none of whose occurrences are left: its declaration goes.
      if (topLocals.has(v)) {
        const all = { kind: NodeKind.CompoundStmt, statements: rewritten } as unknown as ASTNode;
        let left = 0;
        for (const id of findNodesByKind(all, NodeKind.Identifier)) if ((id as Identifier).name === v) left++;
        for (const d of findNodesByKind(all, NodeKind.VariableDecl)) if ((d as VariableDecl).name.name === v) left--;
        if (left === 0) {
          rewritten = rewritten.flatMap((st): Statement[] => {
            if (st.kind !== NodeKind.DeclStmt) return [st];
            const ds = st as DeclStmt;
            const rest = ds.declarations.filter(d => !(d.kind === NodeKind.VariableDecl && (d as VariableDecl).name.name === v));
            if (rest.length === ds.declarations.length) return [st];
            return rest.length === 0 ? [] : [{ ...ds, declarations: rest } as unknown as Statement];
          });
          declared.delete(v);
        }
      }
      const decls = moves.map(m => Stmt.declStmt([Decl.variable(m.local, m.type)]) as unknown as Statement);
      // After the bare declarations: one with an initializer may already use a new local.
      let at = 0;
      while (at < rewritten.length && rewritten[at].kind === NodeKind.DeclStmt
        && (rewritten[at] as DeclStmt).declarations.every(d => d.kind !== NodeKind.VariableDecl || !(d as VariableDecl).initializer)) at++;
      statements = [...rewritten.slice(0, at), ...decls, ...rewritten.slice(at)];
      for (const m of moves) { declared.add(m.local); localTypes.set(m.local, m.type); splitLocals.add(m.local); if (m.cls === 'ptr') pointers.add(m.local); }
      changed = true;
      splitThisRound = true;
    }
    if (!splitThisRound) break;
  }
  return changed ? statements : null;
}

function createSplitLivesTransformer(options?: PluginOptions): Transformer {
  const given = (options ?? {}) as SplitLivesOptions;
  const trace = typeof process !== 'undefined' ? process.env?.SPLIT_LIVES_TRACE : undefined;
  const o: SplitLivesOptions = trace && !given.onReport
    ? { ...given, onReport: (fn, line) => appendFileSync(trace, `${fn}\t${line}\n`) }
    : given;
  if (!o.slots) return (n: ASTNode) => n;
  return createTransformer({
    visitFunctionDecl(fn: FunctionDecl): ASTNode | undefined {
      if (!fn.body) return undefined;
      const statements = splitLives(fn, o);
      if (!statements) return undefined;
      return updateNode(fn, { body: { ...(fn.body as CompoundStmt), statements } } as Partial<FunctionDecl>);
    },
  });
}

export const splitLivesPlugin: TransformPlugin = {
  id: 'split-lives',
  name: 'Split Lives',
  description:
    'Values VC8 kept in one slot or register, merged by the decompiler into one variable -> a local per later value, typed from its own uses, proven by reaching definitions',
  version: '1.0.0',
  defaultEnabled: true,
  // On Ghidra's own spelling, right after reused-param-slot (14) has taken the slots it
  // knows: the new locals are declared as Ghidra would have declared them, and every
  // later pass treats them like one it printed.
  priority: 14.2,
  tags: ['correctness', 'type'],
  createTransformer: createSplitLivesTransformer,
};

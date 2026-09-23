/**
 * AST helpers shared by the defect checks.
 *
 * Every check asks the same handful of questions of an expression - what does this name
 * refer to, what is this constant, how wide is this type, which call is this - and each of
 * them has a shape trap that a text match falls into. They are answered once, here.
 */

import {
  NodeKind,
  getChildren,
  type ASTNode,
  type FunctionDecl,
  type VariableDecl,
  type TypeNode,
} from '@ghidra-mcp/cpp-parser';

/** Primitive widths on the 32-bit target, by the spelling the emitter uses. */
export const PRIMITIVE_WIDTH: Record<string, number> = {
  char: 1, 'signed char': 1, 'unsigned char': 1, bool: 1, byte: 1, BYTE: 1, CHAR: 1, UCHAR: 1,
  uint8_t: 1, int8_t: 1, undefined: 1, undefined1: 1, BOOLEAN: 1,
  short: 2, 'unsigned short': 2, ushort: 2, uint16_t: 2, int16_t: 2, wchar_t: 2, WCHAR: 2,
  undefined2: 2, WORD: 2, USHORT: 2, SHORT: 2,
  int: 4, 'unsigned int': 4, uint: 4, uint32_t: 4, int32_t: 4, long: 4, 'unsigned long': 4,
  ulong: 4, float: 4, DWORD: 4, BOOL: 4, undefined4: 4, UINT: 4, INT: 4, LONG: 4, ULONG: 4,
  size_t: 4, HANDLE: 4, uintptr_t: 4, intptr_t: 4, LPARAM: 4, WPARAM: 4, LPVOID: 4, PVOID: 4,
  uint64_t: 8, int64_t: 8, double: 8, undefined8: 8, 'long long': 8, 'unsigned long long': 8,
  ulonglong: 8, longlong: 8, QWORD: 8,
};

/** Walk every node below `root` (inclusive), handing each its parent. */
export function walk(root: ASTNode, visit: (n: ASTNode, parent: ASTNode | null) => void | 'skip'): void {
  const stack: Array<[ASTNode, ASTNode | null]> = [[root, null]];
  while (stack.length) {
    const [n, p] = stack.pop()!;
    if (!n || typeof n !== 'object') continue;
    if (visit(n, p) === 'skip') continue;
    const kids = getChildren(n);
    for (let i = kids.length - 1; i >= 0; i--) {
      if (kids[i]) stack.push([kids[i], n]);
    }
  }
}

/** Parent links for a subtree - several checks need to ask "what encloses this?". */
export function parentMap(root: ASTNode): Map<ASTNode, ASTNode | null> {
  const m = new Map<ASTNode, ASTNode | null>();
  walk(root, (n, p) => { m.set(n, p); });
  return m;
}

export function line(n: ASTNode | null | undefined): number {
  return (n as any)?.location?.start?.line ?? 0;
}

/** Strip parentheses only. */
export function unparen(e: any): any {
  while (e && e.kind === NodeKind.ParenExpr) e = e.expression;
  return e;
}

const CAST_KINDS = new Set<string>([
  NodeKind.CStyleCastExpr, NodeKind.StaticCastExpr, NodeKind.ReinterpretCastExpr, NodeKind.ConstCastExpr,
]);

export function isCast(e: any): boolean {
  return !!e && CAST_KINDS.has(e.kind);
}

/** Strip parentheses and casts: `(void *)(&x)` is `&x`. */
export function strip(e: any): any {
  for (;;) {
    if (!e) return e;
    if (e.kind === NodeKind.ParenExpr) e = e.expression;
    else if (CAST_KINDS.has(e.kind)) e = e.expression;
    else return e;
  }
}

/**
 * The plain name an expression refers to: `x`, or `::x`. A namespace-qualified name is a
 * different entity from the global of the same spelling and returns null.
 */
export function refName(e: any): string | null {
  if (!e) return null;
  if (e.kind === NodeKind.Identifier && typeof e.name === 'string') return e.name;
  if (e.kind === NodeKind.QualifiedId && e.isGlobal && (!e.qualifier || e.qualifier.length === 0)) {
    const n = e.name;
    return n && typeof n.name === 'string' ? n.name : null;
  }
  return null;
}

/** `&x` (through parens/casts) -> x's name. */
export function addressOfName(e: any): string | null {
  const s = strip(e);
  if (s && s.kind === NodeKind.UnaryExpr && s.operator === '&') return refName(strip(s.operand));
  return null;
}

/** The simple name of a callee: `f`, `ns::f`, `obj.f`, `p->f`. */
export function calleeName(callee: any): string | null {
  if (!callee) return null;
  const c = unparen(callee);
  if (c.kind === NodeKind.Identifier) return c.name;
  if (c.kind === NodeKind.QualifiedId) {
    const n = c.name;
    return typeof n?.name === 'string' ? n.name : null;
  }
  if (c.kind === NodeKind.MemberExpr) {
    const m = c.member;
    return typeof m?.name === 'string' ? m.name : null;
  }
  return null;
}

/** A declarator's name - a string on a fresh parse, an Identifier node after the pipeline. */
export function declName(d: any): string | null {
  const n = d?.name;
  if (typeof n === 'string') return n || null;
  if (n && typeof n === 'object' && typeof n.name === 'string') return n.name || null;
  return null;
}

/** The spelled name of a named type (typedef or elaborated), else null. */
export function typeRefName(t: any): string | null {
  if (!t) return null;
  if (t.kind === NodeKind.QualifiedType) return typeRefName(t.type);
  if (t.kind === NodeKind.TypedefType || t.kind === NodeKind.ElaboratedType) {
    const n = t.name;
    if (n?.kind === NodeKind.Identifier) return n.name;
    if (n?.kind === NodeKind.QualifiedId) return typeof n.name?.name === 'string' ? n.name.name : null;
  }
  return null;
}

/** C spelling of a type, for messages. */
export function typeText(t: any): string {
  if (!t) return '?';
  switch (t.kind) {
    case NodeKind.BuiltinType: return [...(t.modifiers ?? []), t.name].join(' ');
    case NodeKind.TypedefType:
    case NodeKind.ElaboratedType: return typeRefName(t) ?? '?';
    case NodeKind.QualifiedType: return `${t.qualifiers.join(' ')} ${typeText(t.type)}`;
    case NodeKind.PointerType: return `${typeText(t.pointee)}*`;
    case NodeKind.ArrayType: {
      const n = constValue(t.size);
      return `${typeText(t.elementType)}[${n ?? ''}]`;
    }
    case NodeKind.FunctionType: return `${typeText(t.returnType)}(*)()`;
    default: return '?';
  }
}

export function unqualified(t: any): any {
  while (t && t.kind === NodeKind.QualifiedType) t = t.type;
  return t;
}

export function isArrayType(t: any): boolean {
  return unqualified(t)?.kind === NodeKind.ArrayType;
}

export function isPointerType(t: any): boolean {
  return unqualified(t)?.kind === NodeKind.PointerType;
}

/** Length of the OUTERMOST dimension of an array type, when constant. */
export function arrayLength(t: any): number | null {
  const u = unqualified(t);
  if (u?.kind !== NodeKind.ArrayType) return null;
  return constValue(u.size);
}

export function elementType(t: any): any {
  const u = unqualified(t);
  if (u?.kind === NodeKind.ArrayType) return u.elementType;
  if (u?.kind === NodeKind.PointerType) return u.pointee;
  return null;
}

/** The primitive spelling of a type, if it is one: `unsigned int`, `uint8_t`. */
export function primitiveName(t: any): string | null {
  const u = unqualified(t);
  if (!u) return null;
  if (u.kind === NodeKind.BuiltinType) {
    const mods = (u.modifiers ?? []).filter((m: string) => m !== 'signed' || u.name === 'char');
    const spelled = [...mods, u.name].join(' ');
    return PRIMITIVE_WIDTH[spelled] !== undefined ? spelled : u.name;
  }
  const n = typeRefName(u);
  return n && PRIMITIVE_WIDTH[n] !== undefined ? n : null;
}

/** Everything a width computation may consult beyond the primitives. */
export interface SizeEnv {
  /** Byte size of a named struct/typedef, if known (Ghidra's model). */
  named?: (name: string) => number | null;
}

/** sizeof(T) on the 32-bit target, or null when it cannot be derived. */
export function typeWidth(t: any, env: SizeEnv = {}): number | null {
  const u = unqualified(t);
  if (!u) return null;
  switch (u.kind) {
    case NodeKind.PointerType:
    case NodeKind.FunctionType:
      return u.kind === NodeKind.PointerType ? 4 : null;
    case NodeKind.ArrayType: {
      const n = constValue(u.size);
      const w = typeWidth(u.elementType, env);
      return n !== null && w !== null ? n * w : null;
    }
    case NodeKind.BuiltinType: {
      if ((u.modifiers ?? []).filter((m: string) => m === 'long').length >= 2) return 8;
      const p = primitiveName(u);
      if (p && PRIMITIVE_WIDTH[p] !== undefined) return PRIMITIVE_WIDTH[p];
      if (u.name === 'void') return null;
      return PRIMITIVE_WIDTH[u.name] ?? null;
    }
    case NodeKind.TypedefType:
    case NodeKind.ElaboratedType: {
      const n = typeRefName(u);
      if (!n) return null;
      if (PRIMITIVE_WIDTH[n] !== undefined) return PRIMITIVE_WIDTH[n];
      if (n === 'code') return null;
      return env.named?.(n) ?? null;
    }
    default:
      return null;
  }
}

/**
 * The value of an integer constant expression, or null. Casts are transparent (the value
 * is what matters for a size or an index), and `sizeof(T)` folds when `sizeofOf` can size it.
 */
export function constValue(e: any, sizeofOf?: (operand: any, isType: boolean) => number | null): number | null {
  if (!e) return null;
  switch (e.kind) {
    case NodeKind.IntegerLiteral: {
      const v = e.value;
      return typeof v === 'bigint' ? Number(v) : typeof v === 'number' ? v : null;
    }
    case NodeKind.CharLiteral: return typeof e.value === 'number' ? e.value : null;
    case NodeKind.ParenExpr: return constValue(e.expression, sizeofOf);
    case NodeKind.CStyleCastExpr:
    case NodeKind.StaticCastExpr:
    case NodeKind.ReinterpretCastExpr:
      return constValue(e.expression, sizeofOf);
    case NodeKind.SizeofExpr:
      return sizeofOf ? sizeofOf(e.operand, !!e.isType) : null;
    case NodeKind.UnaryExpr: {
      const v = constValue(e.operand, sizeofOf);
      if (v === null) return null;
      if (e.operator === '-') return -v;
      if (e.operator === '+') return v;
      if (e.operator === '~') return ~v;
      return null;
    }
    case NodeKind.BinaryExpr: {
      const a = constValue(e.left, sizeofOf);
      const b = constValue(e.right, sizeofOf);
      if (a === null || b === null) return null;
      switch (e.operator) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return b ? Math.trunc(a / b) : null;
        case '%': return b ? a % b : null;
        case '<<': return a * 2 ** b;
        case '>>': return Math.floor(a / 2 ** b);
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        default: return null;
      }
    }
    default:
      return null;
  }
}

export function isIntLiteral(e: any): boolean {
  const s = strip(e);
  return !!s && (s.kind === NodeKind.IntegerLiteral || s.kind === NodeKind.CharLiteral);
}

/** One entry of a function's scope. */
export interface ScopeEntry {
  name: string;
  decl: VariableDecl | any;
  type: TypeNode | any;
  kind: 'local' | 'param';
  isStatic: boolean;
}

/**
 * Locals and parameters of a function, by name. Fields of a struct declared INSIDE the
 * body (a frame group's `struct __frame0_t { ... }`) are members, not locals, and are
 * deliberately not collected - that is the difference between `__frame0.buf` and `buf`.
 */
export function functionScope(fn: FunctionDecl): Map<string, ScopeEntry> {
  const out = new Map<string, ScopeEntry>();
  for (const p of ((fn as any).parameters ?? []) as any[]) {
    const n = declName(p);
    if (n) out.set(n, { name: n, decl: p, type: p.type, kind: 'param', isStatic: false });
  }
  const body = (fn as any).body;
  if (!body) return out;
  walk(body, (n) => {
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl || n.kind === NodeKind.UnionDecl) {
      return 'skip';
    }
    if (n.kind === NodeKind.VariableDecl) {
      const name = declName(n);
      if (name && !out.has(name)) {
        const specs: string[] = (n as any).specifiers ?? [];
        out.set(name, {
          name, decl: n, type: (n as any).type, kind: 'local',
          isStatic: specs.includes('static') || specs.includes('extern'),
        });
      }
    }
    return undefined;
  });
  return out;
}

/** The struct types declared inside a function body, by name, with their members. */
export function localStructs(fn: FunctionDecl): Map<string, any> {
  const out = new Map<string, any>();
  const body = (fn as any).body;
  if (!body) return out;
  walk(body, (n) => {
    if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl) {
      const name = (n as any).name?.name;
      if (name) out.set(name, n);
    }
  });
  return out;
}

/** Does a struct declaration sit under `#pragma pack(push, 1)`? */
export function isPackedStruct(s: any): boolean {
  if (s?.packed) return true;
  const trivia: any[] = s?.leadingTrivia ?? [];
  let packed = false;
  for (const t of trivia) {
    const text = String(t.text ?? '');
    if (/^#\s*pragma\s+pack\s*\(\s*push\s*,\s*1\s*\)/.test(text)) packed = true;
    else if (/^#\s*pragma\s+pack\s*\(\s*pop\s*\)/.test(text)) packed = false;
  }
  return packed;
}

/**
 * Byte offset of each member of a struct, when every member before it can be sized.
 * Members past the first unsizable one get null.
 */
export function memberOffsets(s: any, env: SizeEnv = {}): Map<string, number | null> {
  const out = new Map<string, number | null>();
  const packed = isPackedStruct(s);
  let off: number | null = 0;
  for (const m of (s?.members ?? []) as any[]) {
    if (m.kind !== NodeKind.VariableDecl) continue;
    const name = declName(m);
    if ((m as any).bitWidth) { off = null; }
    const w = typeWidth(m.type, env);
    let align = 1;
    if (!packed && w !== null) {
      const el = isArrayType(m.type) ? typeWidth(innermostElement(m.type), env) : w;
      align = el && [1, 2, 4, 8].includes(el) ? Math.min(el, 8) : 4;
    }
    if (off !== null) off = Math.ceil(off / align) * align;
    if (name) out.set(name, off);
    off = off !== null && w !== null ? off + w : null;
  }
  return out;
}

export function innermostElement(t: any): any {
  let u = unqualified(t);
  while (u && u.kind === NodeKind.ArrayType) u = unqualified(u.elementType);
  return u;
}

/**
 * A location-free structural signature of a node: kinds, names, operators and literal
 * values, never line numbers or whitespace. Two sites that read the same are the same
 * finding no matter where an edit above them moved them.
 */
export function signature(n: any): string {
  const parts: string[] = [];
  const rec = (x: any, depth: number) => {
    if (!x || typeof x !== 'object' || depth > 40) return;
    parts.push(String(x.kind));
    if (typeof x.name === 'string') parts.push(x.name);
    if (x.kind === NodeKind.QualifiedId) {
      parts.push([...(x.qualifier ?? []).map((q: any) => q?.name?.name ?? q?.name), x.name?.name].join('::'));
    }
    if (typeof x.operator === 'string') parts.push(x.operator);
    if (x.kind === NodeKind.IntegerLiteral) parts.push(String(x.value));
    if (x.kind === NodeKind.StringLiteral || x.kind === NodeKind.CharLiteral) parts.push(JSON.stringify(x.value));
    if (typeof x.isArrow === 'boolean') parts.push(x.isArrow ? '->' : '.');
    parts.push('(');
    for (const c of getChildren(x)) rec(c, depth + 1);
    parts.push(')');
  };
  rec(n, 0);
  return parts.join(' ');
}

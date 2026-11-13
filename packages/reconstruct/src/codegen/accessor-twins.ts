/**
 * Field accessors the original's callers inlined, and the twins `acc` writes them as.
 *
 * D2Common's unit getters (GetType 0044be50, GetGUID 00451f50, GetClassId 00451f60,
 * GetAnimMode 00451f70) are header inlines (inline-hosts.ts): one copy survives at its
 * address, and the rebuild defines it `noinline`, because every module the original
 * linked called that copy. Inside D2Common and the modules that inlined the header,
 * the same accessor was expanded in place, and VC8 compiled the value it returns as a
 * variable of its own: it loads the field into a register and then uses the register,
 * where a plain `p->eUnitType` folds into `cmp dword ptr [p], 1`
 * (MONSTERAI_IsValidResurrectionTarget 005eb650). A `noinline` definition cannot give
 * that, so each such accessor gets an inline twin, `<name>Inline`, written once in the
 * unit ahead of the first function whose `acc` vc8form tag calls it
 * (cpp-parser vc8-form.ts).
 *
 * An accessor is recognised from its decompile, not from a list: a header inline with
 * one pointer parameter whose body returns one field of the pointee, or a constant when
 * the pointer is null - either shape the decompiler prints for it:
 *
 *     if (p == 0) { return K; } return p->F;        GetGUID, GetClassId, GetAnimMode
 *     T v; v = K; if (p != 0) { v = p->F; } return v;    GetType
 *
 * The twin always has the two returns, `if (p) { return p->F; } return K;`: the shape
 * the issue measured, and the one whose value VC8 keeps in a register. Its result type is
 * the field's own, so every read it replaces keeps its type.
 */

import { NodeKind, parse } from '@ghidra-mcp/cpp-parser';
import type { ASTNode, Vc8Accessor } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { isInlineHost } from './inline-hosts.js';

type N = ASTNode & Record<string, any>;

const unparen = (e: N): N => { while (e && e.kind === NodeKind.ParenExpr) e = e.expression; return e; };
const isId = (e: N | undefined, name?: string): boolean => !!e && e.kind === NodeKind.Identifier && (name === undefined || e.name === name);

/** The integer a constant stands for: a literal, its negation, an enumerator, a cast of one. */
function constant(e: N, enumValues: Record<string, number>): bigint | undefined {
  const x = unparen(e);
  if (x.kind === NodeKind.IntegerLiteral) return BigInt(x.value);
  if (x.kind === NodeKind.UnaryExpr && x.operator === '-') { const v = constant(x.operand, enumValues); return v === undefined ? undefined : -v; }
  if (x.kind === NodeKind.CStyleCastExpr) return constant(x.expression, enumValues);
  if (x.kind === NodeKind.Identifier && enumValues[x.name] !== undefined) return BigInt(enumValues[x.name]);
  return undefined;
}

/** `p->a.b` read from parameter p: the path, outermost first. */
function fieldOf(e: N, p: string): string[] | undefined {
  const path: string[] = [];
  let cur = unparen(e);
  while (cur.kind === NodeKind.MemberExpr) {
    if (!isId(cur.member)) return undefined;
    path.unshift(cur.member.name);
    if (cur.isArrow) return isId(unparen(cur.object), p) ? path : undefined;
    cur = unparen(cur.object);
  }
  return undefined;
}

/** 'null' when c holds exactly when p is null, 'set' when exactly when it is not. */
function nullTest(c: N, p: string): 'null' | 'set' | undefined {
  const x = unparen(c);
  if (isId(x, p)) return 'set';
  if (x.kind === NodeKind.UnaryExpr && x.operator === '!' && isId(unparen(x.operand), p)) return 'null';
  if (x.kind === NodeKind.BinaryExpr && (x.operator === '==' || x.operator === '!=') && isId(unparen(x.left), p) && constant(x.right, {}) === 0n) {
    return x.operator === '==' ? 'null' : 'set';
  }
  return undefined;
}

/** The statements of a block or the one statement. */
const stmts = (s: N): N[] => (s.kind === NodeKind.CompoundStmt ? s.statements : [s]);
const exprOf = (s: N): N | undefined => (s.kind === NodeKind.ExprStmt ? s.expression : undefined);

/** The field and the null constant of an accessor body, or undefined. */
export function accessorShape(body: string, param: string, enumValues: Record<string, number>): { path: string[]; dflt: bigint } | undefined {
  let tu: N;
  try { tu = parse(`void accessor_shape() ${body}`) as N; } catch { return undefined; }
  const fn = tu.declarations?.find((d: N) => d.kind === NodeKind.FunctionDecl && d.body) as N | undefined;
  if (!fn) return undefined;
  const st = (fn.body.statements as N[]).filter(s => !(s.kind === NodeKind.DeclStmt && s.declarations?.every((d: N) => !d.initializer)));
  // if (p == 0) { return K; } return p->F;
  if (st.length === 2 && st[0].kind === NodeKind.IfStmt && !st[0].elseBranch && st[1].kind === NodeKind.ReturnStmt) {
    const arm = stmts(st[0].thenBranch);
    if (nullTest(st[0].condition, param) === 'null' && arm.length === 1 && arm[0].kind === NodeKind.ReturnStmt && st[1].value) {
      const dflt = arm[0].value ? constant(arm[0].value, enumValues) : undefined;
      const path = fieldOf(st[1].value, param);
      if (dflt !== undefined && path) return { path, dflt };
    }
  }
  // v = K; if (p != 0) { v = p->F; } return v;
  if (st.length === 3 && st[1].kind === NodeKind.IfStmt && !st[1].elseBranch && st[2].kind === NodeKind.ReturnStmt && st[2].value && isId(unparen(st[2].value))) {
    const v = unparen(st[2].value).name as string;
    const first = exprOf(st[0]);
    const arm = stmts(st[1].thenBranch);
    const store = arm.length === 1 ? exprOf(arm[0]) : undefined;
    const isStore = (e: N | undefined) => !!e && e.kind === NodeKind.AssignExpr && e.operator === '=' && isId(unparen(e.left), v);
    if (isStore(first) && isStore(store) && nullTest(st[1].condition, param) === 'set') {
      const dflt = constant(first!.right, enumValues);
      const path = fieldOf(store!.right, param);
      if (dflt !== undefined && path) return { path, dflt };
    }
  }
  return undefined;
}

/** The body of a decompiled function: from its first `{` on. */
function bodyText(decompiled: string): string | undefined {
  const head = decompiled.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = head.indexOf('{');
  return i < 0 ? undefined : head.slice(i);
}

/** The type the field at path of struct s has, by the struct tables; undefined when unknown. */
function fieldType(s: string, path: string[], structFields: Record<string, Record<string, string>>, typedefTargets: Record<string, string>): string | undefined {
  let cur = s;
  let t: string | undefined;
  for (const f of path) {
    const fields = structFields[cur] ?? structFields[typedefTargets[cur] ?? ''];
    t = fields?.[f];
    if (!t) return undefined;
    cur = t.replace(/^(?:struct|union)\s+/, '').trim();
  }
  return t;
}

/**
 * Every header inline that is such an accessor, with its twin. Two accessors of one field
 * keep neither: which one a read stands for would be a guess.
 */
export function accessorTwins(
  functions: ReadonlyArray<ExtractedFunction>,
  tables: { structFields?: Record<string, Record<string, string>>; typedefTargets?: Record<string, string>; enumValues?: Record<string, number> },
): Vc8Accessor[] {
  const found: Vc8Accessor[] = [];
  const seen = new Map<string, number>();
  for (const func of functions) {
    if (!isInlineHost(func) || func.parameters?.length !== 1 || !func.decompiled) continue;
    const p = func.parameters[0];
    const st = /^\s*(?:struct\s+)?([A-Za-z_]\w*)\s*\*\s*$/.exec(p.dataType ?? '');
    if (!st) continue;
    const body = bodyText(func.decompiled);
    const shape = body ? accessorShape(body, p.name, tables.enumValues ?? {}) : undefined;
    if (!shape) continue;
    const type = fieldType(st[1], shape.path, tables.structFields ?? {}, tables.typedefTargets ?? {});
    if (!type) continue;
    const call = `${func.name}Inline`;
    const read = `pUnit->${shape.path.join('.')}`.replace(/^pUnit/, p.name);
    const key = `${st[1]}.${shape.path.join('.')}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    found.push({
      struct: st[1],
      path: shape.path,
      call,
      dflt: shape.dflt,
      definition: [
        `// ${func.name} as its callers inlined it: two returns, the value in a register of its own.`,
        `static inline ${type} ${call}(${st[1]} * ${p.name}) {`,
        `    if (${p.name}) {`,
        `        return ${read};`,
        `    }`,
        `    return (${type})${shape.dflt < 0n ? `(${shape.dflt})` : shape.dflt};`,
        `}`,
      ].join('\n'),
    });
  }
  return found.filter(a => seen.get(`${a.struct}.${a.path.join('.')}`) === 1);
}

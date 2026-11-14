/**
 * Getters the original's callers expanded in place, and the twins the rebuild calls there.
 *
 * GetQuestBitBuffer (00543520, D2Game::Quests::QUESTS) survives as an extern __fastcall
 * function that ItemMode, SUNITNPC and a few quest units call. The quest callbacks of the
 * A*Q* units hold its body instead, expanded where they read the record:
 *
 *     return GetPlayerData(pUnit)->pQuestRecord[pGame->nDifficulty];
 *
 * A call to the extern copy is a real call, so those sites get an inline twin,
 * `<name>Inline`, forced inline, with the getter's own parameters and body. The twin is
 * defined in the getter's unit's inline header (inline-hosts.ts: bodies needing complete
 * types live there, included by the .cpp files that name them), and the cpp-parser pass
 * getter-twin.ts writes the call where a body holds the expansion.
 *
 * A getter is recognised from its decompile, not from a list: a free function, not a
 * header inline, thunk or library function, whose body is one indexed read of a member of
 * one call's result,
 *
 *     return F(p, ...)->M[q->N];         or     V = F(p, ...); return V->M[q->N];
 *
 * with every argument of F a parameter, the index a member of a parameter, and every
 * parameter used. Two getters of one shape keep neither: which one a site stands for would
 * be a guess.
 */

import { NodeKind, parse } from '@ghidra-mcp/cpp-parser';
import type { ASTNode, GetterTwin } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { isInlineHost } from './inline-hosts.js';
import { declaredParameters, returnSigType } from './header.js';
import { normalizeQualifiedReference } from './namespace.js';

type N = ASTNode & Record<string, any>;

/** A getter with the twin a site calls, and where the twin is defined. */
export interface GetterTwinDef extends GetterTwin {
  /** The getter's address, as the extraction spells it. */
  address: string;
  /** The twin's bare name. */
  name: string;
  /** The getter as extracted: its definition is spelled when the inline header is written. */
  func: ExtractedFunction;
  /** The called function's name as the decompile spells it, qualified. */
  calleeSpelled: string;
  /** The called function's return type, when the extraction has it. */
  calleeReturn?: string;
}

/** The struct a type names through pointers: `struct D2UnitStrc *` -> `D2UnitStrc`. */
export function pointee(type: string | undefined): string | undefined {
  const m = /^\s*(?:const\s+)?(?:struct\s+|union\s+)?(?:::)?([A-Za-z_]\w*)\s*\**\s*$/.exec(type ?? '');
  return m ? m[1] : undefined;
}

/**
 * The twin's definition, for the getter's unit's inline header, inside the namespace the
 * getter is declared in. Spelled when the header is written, so the types are spelled as
 * the unit header spells the getter's own declaration (a type a namespace shadows is
 * root-qualified).
 */
export function getterTwinDefinition(t: GetterTwinDef): string {
  const decl = declaredParameters(t.func);
  const callee = t.calleeSpelled.includes('::') ? normalizeQualifiedReference(t.calleeSpelled) : t.calleeSpelled;
  return [
    `// ${t.func.name} as its callers expanded it: forced inline where the original read the record in place.`,
    `static D2_FORCEINLINE ${returnSigType(t.func.returnType)} ${t.name}(${decl.map(p => `${p.type} ${p.name}`).join(', ')}) {`,
    `    return ${callee}(${t.calleeArgs.map(i => decl[i].name).join(', ')})->${t.member}[${decl[t.indexParam].name}->${t.indexMember}];`,
    `}`,
  ].join('\n');
}

const unparen = (e: N): N => { while (e && e.kind === NodeKind.ParenExpr) e = e.expression; return e; };
const isId = (e: N | undefined, name?: string): boolean => !!e && e.kind === NodeKind.Identifier && (name === undefined || e.name === name);

/** The body of a decompiled function: from its first `{` on, comments dropped. */
function bodyText(decompiled: string): string | undefined {
  const head = decompiled.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = head.indexOf('{');
  return i < 0 ? undefined : head.slice(i);
}

/** The qualified name a call spells, as written. */
function calleeText(e: N): string | undefined {
  const x = unparen(e);
  if (x.kind === NodeKind.Identifier) return x.name;
  if (x.kind === NodeKind.QualifiedId && x.name?.kind === NodeKind.Identifier && x.qualifier.every((q: N) => q.kind === NodeKind.Identifier)) {
    return [...x.qualifier.map((q: N) => q.name), x.name.name].join('::');
  }
  return undefined;
}

interface Shape { callee: string; calleeArgs: number[]; member: string; indexParam: number; indexMember: string }

/** The getter shape of a body over the parameters, or undefined. */
export function getterShape(body: string, params: string[]): Shape | undefined {
  let tu: N;
  try { tu = parse(`void getter_shape() ${body}`) as N; } catch { return undefined; }
  const fn = tu.declarations?.find((d: N) => d.kind === NodeKind.FunctionDecl && d.body) as N | undefined;
  if (!fn) return undefined;
  const st = (fn.body.statements as N[]).filter(s => !(s.kind === NodeKind.DeclStmt && s.declarations?.every((d: N) => !d.initializer)));
  let call: N | undefined;
  let ret: N | undefined;
  if (st.length === 1 && st[0].kind === NodeKind.ReturnStmt && st[0].value) {
    ret = unparen(st[0].value);
  } else if (st.length === 2 && st[0].kind === NodeKind.ExprStmt && st[1].kind === NodeKind.ReturnStmt && st[1].value) {
    const a = unparen(st[0].expression);
    if (a.kind !== NodeKind.AssignExpr || a.operator !== '=' || !isId(unparen(a.left))) return undefined;
    call = unparen(a.right);
    ret = unparen(st[1].value);
    // V->M[...] with V the held call.
    const arr = ret.kind === NodeKind.SubscriptExpr ? unparen(ret.array) : undefined;
    if (!arr || arr.kind !== NodeKind.MemberExpr || !isId(unparen(arr.object), unparen(a.left).name)) return undefined;
  } else {
    return undefined;
  }
  if (!ret || ret.kind !== NodeKind.SubscriptExpr) return undefined;
  const arr = unparen(ret.array);
  if (arr.kind !== NodeKind.MemberExpr || !arr.isArrow || !isId(arr.member)) return undefined;
  call = call ?? unparen(arr.object);
  if (call.kind !== NodeKind.CallExpr) return undefined;
  const callee = calleeText(call.callee);
  if (!callee) return undefined;
  const calleeArgs: number[] = [];
  for (const a of call.arguments as N[]) {
    const x = unparen(a);
    const i = isId(x) ? params.indexOf(x.name) : -1;
    if (i < 0) return undefined;
    calleeArgs.push(i);
  }
  const idx = unparen(ret.index);
  if (idx.kind !== NodeKind.MemberExpr || !idx.isArrow || !isId(idx.member) || !isId(unparen(idx.object))) return undefined;
  const indexParam = params.indexOf(unparen(idx.object).name);
  if (indexParam < 0) return undefined;
  const used = new Set([...calleeArgs, indexParam]);
  if (used.size !== params.length) return undefined;
  return { callee, calleeArgs, member: arr.member.name, indexParam, indexMember: idx.member.name };
}

/** Every getter of that shape, with its twin. */
export function getterTwins(functions: ReadonlyArray<ExtractedFunction>): GetterTwinDef[] {
  const found: GetterTwinDef[] = [];
  const seen = new Map<string, number>();
  for (const func of functions) {
    if (!func.decompiled || isInlineHost(func) || func.isThunk || func.isExternal || func.isLibrary || func.parentClass) continue;
    if (func.ifdef || func.platform || func.hasVarArgs || !func.namespace) continue;
    const params = (func.parameters ?? []).map(p => p.name);
    if (params.length === 0) continue;
    const body = bodyText(func.decompiled);
    const shape = body ? getterShape(body, params) : undefined;
    if (!shape) continue;
    const name = `${func.name}Inline`;
    const key = `${shape.callee.replace(/^.*::/, '')}/${shape.calleeArgs.length}/${shape.member}/${shape.indexMember}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
    found.push({
      ...shape,
      callee: shape.callee.replace(/^.*::/, ''),
      params: params.length,
      address: func.address,
      name,
      // Spelled as the getter's own references are, with the twin's name.
      call: `${normalizeQualifiedReference(`${func.namespace}::${func.name}`).replace(/[^:]+$/, '')}${name}`,
      func,
      calleeSpelled: shape.callee,
      calleeReturn: functions.find(f => f.namespace && `${f.namespace}::${f.name}` === shape.callee)?.returnType,
    });
  }
  return found.filter(t => seen.get(`${t.callee}/${t.calleeArgs.length}/${t.member}/${t.indexMember}`) === 1);
}

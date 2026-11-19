/**
 * Header inlines the original's callers expanded in place, and the twins the rebuild calls there.
 *
 * GetXPosFromDynamicPathUnit (0045adf0) and GetYPosFromDynamicPathUnit (0045ae20) are header
 * inlines (inline-hosts.ts): one copy survives at its address, defined `noinline` because the
 * modules that linked it called it (the quest units of D2Game). Everywhere else - D2Game's
 * AI, missiles, skills, D2Client's units - the same function was expanded in place, about four
 * hundred times, and the decompiler prints each expansion its own way (arms swapped, the call
 * copied through a temporary, the store tail-duplicated into the call that reads it). A call to
 * the `noinline` copy is a real call, so such a host gets a twin, `<name>Inline`, forced
 * inline, with the host's own parameter and body, defined in `<unit>.twin.inline.h` beside the
 * unit's inline header and included only by the files that call a twin (a definition added to
 * the inline header itself moved code in units that never call it: 004e89a0 lost its MATCH).
 * The cpp-parser pass host-twin-fold.ts proves a site computes what the host returns and writes
 * the twin's call there.
 *
 * The twin's body is the host's as the inline header emits it, not as decompiled: VC8 compiles
 * a test as spelled, and the decompiler's `(int)t < 4` is the header's `(int)t <= 3`.
 *
 * A host is recognised from its decompile, not from a list: a header inline with one pointer
 * parameter and an integer return of at most 32 bits, whose body is declarations, loads of the
 * parameter's fields into temporaries, tests of those fields and returns of a field, a constant
 * or the result of a call whose arguments are fields of the parameter - and that calls on at
 * least one path. A field accessor without a call (GetGUID, GetType) has a twin of its own
 * that `acc` vc8form tags call (accessor-twins.ts).
 */

import { NodeKind, parse, emit, cloneNode } from '@ghidra-mcp/cpp-parser';
import type { ASTNode, CompoundStmt, FunctionDecl, HostTwin } from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';
import { isInlineHost } from './inline-hosts.js';
import { declaredParameters, returnSigType } from './header.js';
import { normalizeQualifiedReference } from './namespace.js';

type N = ASTNode & Record<string, any>;

/** A host with its twin, and where the twin is defined. */
export interface HostTwinDef extends HostTwin {
  /** The host's address, as the extraction spells it. */
  address: string;
  /** The twin's bare name. */
  name: string;
  func: ExtractedFunction;
}

const INT_RETURNS = new Set(['int', 'int32_t', 'uint32_t', 'uint', 'unsigned int', 'short', 'int16_t', 'uint16_t', 'char', 'uint8_t', 'int8_t', 'BOOL', 'DWORD', 'WORD', 'BYTE']);

const unparen = (e: N): N => { while (e && e.kind === NodeKind.ParenExpr) e = e.expression; return e; };

/** The body of a decompiled function: from its first `{` on, comments dropped. */
function bodyText(decompiled: string): string | undefined {
  const head = decompiled.replace(/\/\*[\s\S]*?\*\//g, '');
  const i = head.indexOf('{');
  return i < 0 ? undefined : head.slice(i);
}

/** `p->a.b` rooted at the parameter. */
function isParamField(e: N, param: string): boolean {
  let x = unparen(e);
  if (x.kind !== NodeKind.MemberExpr) return false;
  while (x.kind === NodeKind.MemberExpr) {
    if (x.member?.kind !== NodeKind.Identifier) return false;
    x = unparen(x.object);
  }
  return x.kind === NodeKind.Identifier && x.name === param;
}

function isConstant(e: N): boolean {
  const x = unparen(e);
  if (x.kind === NodeKind.IntegerLiteral || x.kind === NodeKind.NullptrLiteral) return true;
  if (x.kind === NodeKind.UnaryExpr && x.operator === '-') return isConstant(x.operand);
  if (x.kind === NodeKind.CStyleCastExpr) return isConstant(x.expression);
  return false;
}

/** Whether the body has the host shape; true also needs a call on some path. */
function hostShape(body: CompoundStmt, param: string): boolean {
  const held = new Set<string>();
  let calls = 0;
  const ok = (stmts: N[]): boolean => stmts.every(s => {
    switch (s.kind) {
      case NodeKind.DeclStmt:
        return s.declarations.every((d: N) => d.kind === NodeKind.VariableDecl && !d.initializer);
      case NodeKind.ExprStmt: {
        const e = unparen(s.expression);
        if (e.kind !== NodeKind.AssignExpr || e.operator !== '=' || unparen(e.left).kind !== NodeKind.Identifier) return false;
        const r = unparen(e.right);
        if (isParamField(r, param)) return true;
        if (r.kind === NodeKind.CallExpr && r.arguments.length > 0 && r.arguments.every((a: N) => isParamField(a, param))) {
          held.add(unparen(e.left).name);
          calls++;
          return true;
        }
        return false;
      }
      case NodeKind.IfStmt:
        return !s.init && ok(s.thenBranch.kind === NodeKind.CompoundStmt ? s.thenBranch.statements : [s.thenBranch])
          && (!s.elseBranch || ok(s.elseBranch.kind === NodeKind.CompoundStmt ? s.elseBranch.statements : [s.elseBranch]));
      case NodeKind.ReturnStmt: {
        const v = s.value ? unparen(s.value) : null;
        if (!v) return false;
        if (v.kind === NodeKind.Identifier) return held.has(v.name);
        return isParamField(v, param) || isConstant(v);
      }
      default:
        return false;
    }
  });
  return ok(body.statements as N[]) && calls > 0;
}

/** The parsed host body with the decompiler's member parentheses dropped, for printing. */
function tidy(n: N): N {
  for (const [k, v] of Object.entries(n)) {
    if (k === 'leadingTrivia' || k === 'trailingTrivia' || !v || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      v.forEach((c, i) => {
        if (c && typeof c === 'object' && 'kind' in c) {
          let x = c as N;
          if (x.kind === NodeKind.ParenExpr && [NodeKind.MemberExpr, NodeKind.Identifier].includes(unparen(x).kind)) x = unparen(x);
          v[i] = tidy(x);
        }
      });
    } else if ('kind' in v) {
      let x = v as N;
      if (x.kind === NodeKind.ParenExpr && [NodeKind.MemberExpr, NodeKind.Identifier].includes(unparen(x).kind)) x = unparen(x);
      (n as Record<string, unknown>)[k] = tidy(x);
    }
  }
  return n;
}

/** The header a unit's twins are defined in, beside its inline header: `Units.h` -> `Units.twin.inline.h`. */
export function hostTwinHeaderPath(unitHeaderPath: string): string {
  return unitHeaderPath.replace(/\.h$/, '') + '.twin.inline.h';
}

/** Every host of that shape, with its twin. */
export function hostTwins(functions: ReadonlyArray<ExtractedFunction>): HostTwinDef[] {
  const found: HostTwinDef[] = [];
  for (const func of functions) {
    if (!func.decompiled || !isInlineHost(func) || func.hasVarArgs || !func.namespace) continue;
    const params = func.parameters ?? [];
    if (params.length !== 1 || !/\*\s*$/.test(params[0].dataType ?? '')) continue;
    if (!INT_RETURNS.has((func.returnType ?? '').trim())) continue;
    const body = bodyText(func.decompiled);
    if (!body) continue;
    let fn: FunctionDecl | undefined;
    try {
      const tu = parse(`int host_shape() ${body}`) as N;
      fn = tu.declarations?.find((d: N) => d.kind === NodeKind.FunctionDecl && d.body) as FunctionDecl | undefined;
    } catch { continue; }
    if (!fn?.body || !hostShape(fn.body, params[0].name)) continue;
    const locals: Record<string, string> = {};
    for (const s of fn.body.statements as N[]) {
      if (s.kind !== NodeKind.DeclStmt) continue;
      for (const d of s.declarations as N[]) locals[d.name.name] = emit(d.type).trim();
    }
    const name = `${func.name}Inline`;
    found.push({
      call: `${normalizeQualifiedReference(`${func.namespace}::${func.name}`).replace(/[^:]+$/, '')}${name}`,
      param: params[0].name,
      returnType: func.returnType!.trim(),
      body: fn.body,
      locals,
      address: func.address,
      name,
      func,
    });
  }
  return found;
}

/** The host's body as the unit's inline header emits it: the pipeline's spelling of each test. */
function emittedBody(t: HostTwinDef, inlineHeader: string | undefined): CompoundStmt | undefined {
  if (!inlineHeader) return undefined;
  let tu: N;
  try { tu = parse(inlineHeader) as N; } catch { return undefined; }
  let found: CompoundStmt | undefined;
  const visit = (n: N): void => {
    if (found || !n || typeof n !== 'object') return;
    if (n.kind === NodeKind.FunctionDecl && n.body) {
      const nm = n.name?.kind === NodeKind.Identifier ? n.name.name : n.name?.name?.name;
      if (nm === t.func.name) { found = n.body; return; }
    }
    for (const k of ['declarations', 'body']) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(visit);
      else if (v && typeof v === 'object' && k === 'body' && n.kind !== NodeKind.FunctionDecl) visit(v);
    }
  };
  visit(tu);
  return found;
}

/**
 * The twin's definition, for the host's unit's inline header, inside the namespace the host is
 * declared in: the host's signature, forced inline, and the host's body as the header emits it
 * (VC8 compiles a test as spelled: `(int)t < 4` and `(int)t <= 3` are different code), or the
 * decompiled body when the header holds no definition of it.
 */
export function hostTwinDefinition(t: HostTwinDef, inlineHeader?: string): string {
  const decl = declaredParameters(t.func);
  const emitted = emittedBody(t, inlineHeader);
  const body = emitted ? cloneNode(emitted) as N : tidy(cloneNode(t.body) as N);
  const text = emit(body as never).replace(/\s+$/, '');
  return [
    `// ${t.func.name} as its callers expanded it: forced inline where the original computed the value in place.`,
    `static D2_FORCEINLINE ${returnSigType(t.func.returnType)} ${t.name}(${decl[0].type} ${t.param}) ${text}`,
  ].join('\n');
}

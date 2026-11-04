/**
 * An MSVC `__finally` block called with its parent's frame, inlined into the parent.
 *
 * D2FILE_GetSignerOrganization (00517c30) has an EH4 frame (`_SEH_prolog4`). Its
 * termination handler is the block at 00517df5, which MSVC compiles as code that runs on
 * the parent's frame: the normal exit CALLs it after `[ebp-4] = -2`, and it reads the
 * parent's locals through EBP. Ghidra made it a function of its own whose "parameters" are
 * the registers it inherits:
 *
 *     void D2FILE_CleanupCryptHandles(DWORD dwNull @EBX, int32_t nFrameBase @EBP)
 *     {
 *       if (*(DWORD *)(nFrameBase + -0x2c) != dwNull) LocalFree(*(HLOCAL *)(nFrameBase + -0x2c));
 *       ...
 *     }
 *
 * and the parent passes it `(int32_t)&stack0xfffffffc`. Emitted as written, the callee
 * reads fixed offsets of a frame that only MSVC lays out that way: under any other compiler
 * those offsets hold other locals, and the handles are freed wrong.
 *
 * Here the block is put back where it belongs, at its one call site, with every
 * `*(T *)(nFrameBase + -k)` spelled as the parent local at that frame offset: the call
 * passes the frame as `&stack0x<f>` (EBP is the entry ESP + f), so `[EBP - k]` is the
 * local Ghidra stores at `Stack[f - k]`. The other register parameters take the call's
 * argument (`dwNull` is EBX, which the parent zeroed: `0`). The result is what the source
 * had, the cleanup in the parent, reading its own locals:
 *
 *     if (hMsgInfo != 0) LocalFree(hMsgInfo);
 *
 * A read of a different type than the local's keeps the reinterpretation the instruction
 * makes, `*(T *)&local`, so every value is the one the original reads.
 *
 * Exact, never inferred; anything else leaves both functions as they are:
 *  - the callee returns void, has exactly one parameter in EBP and every other parameter
 *    in a register, and is named by no function but its caller;
 *  - caller and callee are in one namespace (one unit: the callee's text is an input of
 *    the caller's unit and of nothing else);
 *  - the call is a statement of its own, once, its frame argument `&stack0x<f>` and its
 *    other arguments literals or names;
 *  - the frame parameter is used only as `*(T *)(P + -k)` / `*(T *)(P - k)`, and each
 *    `Stack[f - k]` is the storage of exactly one parent local of T's width;
 *  - the callee's `return`s are its last statement or `if (C) return;` at its top level,
 *    which becomes `if (!(C)) { <rest> }`: the same statements run on every path.
 *
 * Exception unwind: the rebuild registers no EH4 frame, so the handler path that would
 * also run the block does not exist on either side of this rewrite.
 */

import {
  parse, emit, findNodesByKind, NodeKind, createTransformer,
  type AnyNode, type ASTNode, type CallExpr, type CompoundStmt, type Expression, type FunctionDecl,
  type Statement,
} from '@ghidra-mcp/cpp-parser';
import type { ExtractedFunction } from '../types.js';

export interface FrameFuncletInline {
  parent: string;
  funclet: string;
  funcletAddress: string;
  /** frame offset from EBP -> parent local */
  slots: Record<number, string>;
}

export interface FrameFuncletResult {
  functions: ExtractedFunction[];
  inlined: FrameFuncletInline[];
  refusals: string[];
}

type Node = ASTNode & Record<string, unknown>;

function unwrap(e: Expression): Expression {
  let x = e as Node;
  while (x.kind === NodeKind.ParenExpr) x = x.expression as Node;
  return x as unknown as Expression;
}

function lastName(e: Expression): string | null {
  const x = unwrap(e) as Node;
  if (x.kind === NodeKind.Identifier) return x.name as string;
  if (x.kind === NodeKind.QualifiedId) {
    const n = x.name as Node;
    return n.kind === NodeKind.Identifier ? (n.name as string) : null;
  }
  return null;
}

function literalValue(e: Expression): number | null {
  const x = unwrap(e) as Node;
  if (x.kind === NodeKind.IntegerLiteral) return Number(x.value as bigint);
  if (x.kind === NodeKind.UnaryExpr && x.operator === '-') {
    const v = unwrap(x.operand as Expression) as Node;
    if (v.kind === NodeKind.IntegerLiteral) return -Number(v.value as bigint);
  }
  return null;
}

/** `Stack[-0x30]:4` -> { offset: -0x30, size: 4 }. */
function stackSlot(storage: string | undefined): { offset: number; size: number } | null {
  const m = /^Stack\[(-?)0x([0-9a-f]+)\]:(\d+)$/i.exec(storage ?? '');
  if (!m) return null;
  const v = Number.parseInt(m[2]!, 16);
  return { offset: m[1] ? -v : v, size: Number(m[3]) };
}

/** The width of a deref type the funclet reads its frame through, where it is a word. */
const WORD_TYPES = /^(DWORD|uint|int|undefined4|int32_t|uint32_t|BOOL|LONG|ULONG|H[A-Z]+|P[A-Z_]+|LP[A-Z_]+|\w+ \*)$/;

function typeSpelling(t: ASTNode): string {
  return emit(t as AnyNode).replace(/\s+/g, ' ').trim();
}

function functionDecl(ast: ASTNode): FunctionDecl | null {
  const decls = findNodesByKind(ast, NodeKind.FunctionDecl) as FunctionDecl[];
  const withBody = decls.filter(d => d.body);
  return withBody.length === 1 ? withBody[0]! : null;
}

/** `*(T *)(P + -k)`: the frame offset and T, or null. */
function frameRead(e: ASTNode, param: string): { k: number; type: string } | null {
  const u = e as Node;
  if (u.kind !== NodeKind.UnaryExpr || u.operator !== '*') return null;
  const c = unwrap(u.operand as Expression) as Node;
  if (c.kind !== NodeKind.CStyleCastExpr) return null;
  const t = c.type as Node;
  if (t.kind !== NodeKind.PointerType) return null;
  const sum = unwrap(c.expression as Expression) as Node;
  if (sum.kind !== NodeKind.BinaryExpr || (sum.operator !== '+' && sum.operator !== '-')) return null;
  if (lastName(sum.left as Expression) !== param) return null;
  const v = literalValue(sum.right as Expression);
  if (v === null) return null;
  const k = sum.operator === '+' ? -v : v;
  return { k, type: typeSpelling(t.pointee as ASTNode) };
}

/** The statements of a void body with its returns folded into conditions, or null. */
function withoutReturns(statements: readonly Statement[]): Statement[] | null {
  const out: Statement[] = [];
  for (let i = 0; i < statements.length; i++) {
    const st = statements[i]! as unknown as Node;
    if (st.kind === NodeKind.ReturnStmt) {
      if (st.value) return null;
      // A return with statements after it: those are unreachable on that path only if
      // nothing jumps past it, which a body with no labels guarantees.
      return out;
    }
    if (st.kind === NodeKind.IfStmt && !st.elseBranch) {
      const then = st.thenBranch as Node;
      const body = then.kind === NodeKind.CompoundStmt ? (then.statements as Node[]) : [then];
      if (body.length === 1 && body[0]!.kind === NodeKind.ReturnStmt && !body[0]!.value) {
        const rest = withoutReturns(statements.slice(i + 1));
        if (!rest) return null;
        if (rest.length > 0) {
          const negated = { kind: NodeKind.UnaryExpr, operator: '!', operand: { kind: NodeKind.ParenExpr, expression: st.condition, leadingTrivia: [], trailingTrivia: [] }, prefix: true, leadingTrivia: [], trailingTrivia: [] };
          out.push({ ...st, condition: negated, thenBranch: { kind: NodeKind.CompoundStmt, statements: rest, leadingTrivia: [], trailingTrivia: [] } } as unknown as Statement);
        }
        return out;
      }
    }
    if (findNodesByKind(st as ASTNode, NodeKind.ReturnStmt).length > 0) return null;
    if (findNodesByKind(st as ASTNode, NodeKind.LabelStmt).length > 0) return null;
    out.push(st as unknown as Statement);
  }
  return out;
}

export function inlineFrameFunclets(functions: readonly ExtractedFunction[]): FrameFuncletResult {
  const refusals: string[] = [];
  const inlined: FrameFuncletInline[] = [];
  const candidates = functions.filter(f => !f.isThunk && f.decompiled && /^void\b/.test(f.returnType ?? '')
    && (f.parameters ?? []).filter(p => p.storage === 'EBP:4').length === 1
    && (f.parameters ?? []).every(p => /^E[A-Z]{2}:4$/.test(p.storage ?? '')));
  if (candidates.length === 0) return { functions: [...functions], inlined, refusals };

  const replaced = new Map<ExtractedFunction, ExtractedFunction>();
  const dropped = new Set<ExtractedFunction>();
  for (const funclet of candidates) {
    const callers = functions.filter(f => f !== funclet && f.decompiled && f.decompiled.includes(funclet.name)
      && new RegExp(`\\b${funclet.name}\\s*\\(`).test(f.decompiled));
    const refuse = (why: string) => refusals.push(`${funclet.address} ${funclet.name}: ${why}`);
    if (callers.length !== 1) { if (callers.length > 1) refuse(`${callers.length} callers`); continue; }
    const parent = replaced.get(callers[0]!) ?? callers[0]!;
    if ((parent.namespace ?? '') !== (funclet.namespace ?? '')) { refuse(`caller ${parent.name} is in another namespace`); continue; }
    const frameParam = funclet.parameters.find(p => p.storage === 'EBP:4')!;

    let calleeAst: ASTNode, parentAst: ASTNode;
    try { calleeAst = parse(funclet.decompiled!); parentAst = parse(parent.decompiled!); } catch { refuse('does not parse'); continue; }
    const callee = functionDecl(calleeAst);
    if (!callee || !callee.body) { refuse('no body'); continue; }

    // Every use of the frame parameter is a read of a fixed frame offset.
    const reads = new Map<ASTNode, { k: number; type: string }>();
    for (const u of findNodesByKind(callee.body, NodeKind.UnaryExpr)) {
      const r = frameRead(u, frameParam.name);
      if (r) reads.set(u, r);
    }
    const uses = findNodesByKind(callee.body, NodeKind.Identifier).filter(id => (id as Node).name === frameParam.name).length;
    if (uses !== reads.size || uses === 0) { refuse(`${frameParam.name} is used other than as a frame read`); continue; }

    // The one call, a statement of its own.
    const calls = (findNodesByKind(parentAst, NodeKind.CallExpr) as CallExpr[]).filter(c => lastName(c.callee) === funclet.name);
    if (calls.length !== 1) { refuse(`${calls.length} calls in ${parent.name}`); continue; }
    const call = calls[0]!;
    const stmt = (findNodesByKind(parentAst, NodeKind.ExprStmt) as Node[]).find(s => unwrap(s.expression as Expression) === (call as unknown as Expression));
    if (!stmt) { refuse('the call is not a statement'); continue; }
    if (call.arguments.length !== funclet.parameters.length) { refuse('argument count'); continue; }

    // The frame argument: (T)&stack0x<f>.
    const ordinal = funclet.parameters.indexOf(frameParam);
    let frameArg = unwrap(call.arguments[ordinal] as Expression) as Node;
    if (frameArg.kind === NodeKind.CStyleCastExpr) frameArg = unwrap(frameArg.expression as Expression) as Node;
    const stackName = frameArg.kind === NodeKind.UnaryExpr && frameArg.operator === '&' ? lastName(frameArg.operand as Expression) : null;
    const m = stackName ? /^stack0x([0-9a-f]{8})$/i.exec(stackName) : null;
    if (!m) { refuse('the frame argument is not &stack0x<f>'); continue; }
    const f = Number.parseInt(m[1]!, 16) | 0;

    // Every other argument a literal or a name: substituting it cannot change evaluation.
    const args = new Map<string, Expression>();
    let argsOk = true;
    funclet.parameters.forEach((p, i) => {
      if (i === ordinal) return;
      const a = unwrap(call.arguments[i] as Expression) as Node;
      if (a.kind !== NodeKind.IntegerLiteral && a.kind !== NodeKind.Identifier) argsOk = false;
      args.set(p.name, call.arguments[i] as Expression);
    });
    if (!argsOk) { refuse('an argument with side effects'); continue; }

    // Each frame offset is one parent local of the read's width.
    const byOffset = new Map<number, { name: string; type: string; size: number }[]>();
    for (const v of parent.localVariables ?? []) {
      const s = stackSlot(v.storage);
      if (!s) continue;
      const list = byOffset.get(s.offset) ?? [];
      list.push({ name: v.name, type: (v.dataType ?? '').replace(/\s+/g, ' ').trim(), size: s.size });
      byOffset.set(s.offset, list);
    }
    const slots: Record<number, string> = {};
    let slotsOk = true;
    for (const r of reads.values()) {
      const at = byOffset.get(f - r.k);
      if (!at || at.length !== 1 || at[0]!.size !== 4 || !WORD_TYPES.test(r.type)) {
        refuse(`[EBP-0x${r.k.toString(16)}] (Stack[${f - r.k}]) is not one word local of ${parent.name}`);
        slotsOk = false;
        break;
      }
      slots[r.k] = at[0]!.name;
    }
    if (!slotsOk) continue;
    const localType = (k: number) => byOffset.get(f - k)![0]!.type;

    // Substitute, then fold the returns.
    const substituted = createTransformer({
      visitNode(n: ASTNode): ASTNode | undefined {
        const r = frameRead(n, frameParam.name);
        if (r) {
          const local = { kind: NodeKind.Identifier, name: slots[r.k]!, leadingTrivia: [], trailingTrivia: [] } as unknown as Expression;
          if (r.type.replace(/\s*\*$/, ' *') === localType(r.k).replace(/\s*\*$/, ' *')) return local as unknown as ASTNode;
          return reinterpretation(r.type, slots[r.k]!);
        }
        const x = n as Node;
        if (x.kind === NodeKind.Identifier && args.has(x.name as string)) return args.get(x.name as string) as unknown as ASTNode;
        return undefined;
      },
    })(callee.body) as CompoundStmt;
    const statements = withoutReturns(substituted.statements);
    if (!statements) { refuse('a return the inlined block cannot keep'); continue; }

    // Splice the block over the call statement in the parent's text: from the statement's
    // first token to the `;` after the call's balanced argument list.
    const start = ((stmt as Node).location as { start: { offset: number } } | undefined)?.start.offset;
    const end = start === undefined ? null : statementEnd(parent.decompiled!, start);
    if (start === undefined || end === null || parent.decompiled!.slice(start, end).indexOf(funclet.name) < 0) { refuse('no source span for the call'); continue; }
    const loc = { start: { offset: start }, end: { offset: end } };
    const block = `/* __finally block ${funclet.address} ${funclet.name}, on its parent locals */\n`
      + statements.map(s => emit(s as unknown as AnyNode)).join('\n');
    const text = parent.decompiled!.slice(0, loc.start.offset) + `{\n${block}\n}` + parent.decompiled!.slice(loc.end.offset);
    replaced.set(callers[0]!, { ...parent, decompiled: text });
    dropped.add(funclet);
    inlined.push({ parent: parent.name, funclet: funclet.name, funcletAddress: funclet.address, slots });
  }

  const out: ExtractedFunction[] = [];
  for (const fn of functions) {
    if (dropped.has(fn)) continue;
    out.push(replaced.get(fn) ?? fn);
  }
  return { functions: out, inlined, refusals };
}

/** `*(T *)&local`: the read the instruction makes, through the local's own storage. */
function reinterpretation(type: string, local: string): ASTNode {
  const ast = parse(`void f(){ x = *(${type} *)&${local}; }`);
  const assign = findNodesByKind(ast, NodeKind.AssignExpr)[0] as Node;
  return assign.right as ASTNode;
}

/**
 * The offset just past the `;` that ends the call statement starting at `start`: the first
 * `(` opens the argument list, which ends at its balanced `)`. String and character
 * literals and comments are skipped. Null when the text does not have that shape.
 */
function statementEnd(text: string, start: number): number | null {
  let depth = 0;
  let opened = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"' || c === "'") {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) return null; i = j + 1; continue; }
    if (c === '/' && text[i + 1] === '/') { const j = text.indexOf('\n', i); if (j < 0) return null; i = j; continue; }
    if (c === '(') { depth++; opened = true; continue; }
    if (c === ')') { depth--; if (depth < 0) return null; continue; }
    if (c === ';' && depth === 0) return opened ? i + 1 : null;
    if ((c === '{' || c === '}') && depth === 0) return null;
  }
  return null;
}

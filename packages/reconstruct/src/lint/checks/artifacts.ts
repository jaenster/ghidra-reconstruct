/**
 * Decompiler notation that reached the emitted tree.
 *
 * Ghidra prints what an instruction or a storage location has no C spelling for as notation
 * of its own: pseudo-op calls (`SUB41`, `CARRY4`, `ROUND`), frame and register names
 * (`in_stack_0000000c`, `extraout_EAX`), its own types (`undefined4`, `unkfloat1`, `int3`),
 * subpiece members (`x._0_3_`), `WARNING` comments and integers printed through a float type
 * (`1.4013e-45`). Each is either lowered by the generator or fixed in Ghidra; whatever is left
 * is counted here.
 *
 * Every rule is an exact match on ONE node's name - an identifier, a type name, a member name,
 * a literal value or a comment's leading word - never a search through source text, so a
 * string, a longer name containing the word, or a Winsock `in_addr` cannot match.
 *
 * Unlike the defect checks this one is not judged against the content-keyed baseline. Its
 * gate is a per-rule COUNT (`ghidra-artifact-allowlist.json`) that may only shrink: a class
 * the generator lowers is at 0 and stays there, a class waiting on Ghidra carries the count it
 * had when it was written down.
 */

import { NodeKind, TriviaKind, getChildren, type ASTNode } from '@ghidra-mcp/cpp-parser';
import { declName, line, signature, unparen } from '../ast.js';
import type { Check, Finding } from '../context.js';
import type { FunctionInfo, SourceFile } from '../tree.js';

export const GHIDRA_ARTIFACT_CHECK_ID = 'ghidra-artifact';

/** The rules, in report order. A finding's `subject` is its rule id. */
export const GHIDRA_ARTIFACT_RULES = [
  'pseudo-op-call',
  'pseudo-constant',
  'frame-name',
  'register-name',
  'ghidra-type',
  'subpiece-member',
  'warning-comment',
  'denormal-literal',
] as const;
export type GhidraArtifactRule = typeof GHIDRA_ARTIFACT_RULES[number];

/** The header that defines the pseudo-ops for the build; defining them is its job. */
const PLATFORM_HEADER = 'd2_platform.h';

const SIZED_PSEUDO_OP = /^(CONCAT|SUB|ZEXT|SEXT|CARRY|SCARRY|SBORROW)\d+$/;
const NAMED_PSEUDO_OP = new Set([
  'POPCOUNT', 'LZCOUNT', 'ROUND', 'ABS', 'SQRT', 'NAN', 'ZPULL', 'SPULL', 'swi', 'halt_baddata',
  'halt_unimplemented', 'rdtsc', 'LOCK', 'UNLOCK', 'FLOAT_UNKNOWN',
]);
const BUILTIN_PSEUDO_OP = /^builtin_[a-z]+$/;
const CPUID_PSEUDO_OP = /^cpuid_/;

export function isPseudoOpName(name: string): boolean {
  return SIZED_PSEUDO_OP.test(name) || NAMED_PSEUDO_OP.has(name) ||
    BUILTIN_PSEUDO_OP.test(name) || CPUID_PSEUDO_OP.test(name);
}

const FRAME_NAME = /^(stack0x[0-9a-f]+|in_stack_[0-9a-f]+|in_register_[0-9a-f]+)$/;
/**
 * A register Ghidra could not attribute. `in_` is followed by an UPPERCASE register
 * (`in_EAX`, `in_FS_OFFSET`, `in_XMM0`), which is what keeps Winsock's `in_addr`, `in6_addr`
 * and `sockaddr_in` out. `extraout_`/`unaff_` have no real-name lookalikes and carry
 * lowercase forms of their own (`extraout_var`, `unaff_retaddr`).
 */
const REGISTER_NAME = /^(extraout_\w+|unaff_\w+|in_[A-Z][A-Z0-9_]*)$/;
const GHIDRA_TYPE = /^(unk(byte|uint|int|float|bool)\d+|undefined\d*|u?int[3567]|float10|float2)$/;
const SUBPIECE_MEMBER = /^_\d+_\d+_$/;
/** FLT_MIN. A nonzero float literal below it is a denormal: an integer printed through a float type. */
const FLT_MIN = 1.17549435e-38;

export function isFrameName(name: string): boolean { return FRAME_NAME.test(name); }
export function isRegisterName(name: string): boolean { return REGISTER_NAME.test(name); }
export function isGhidraTypeName(name: string): boolean { return GHIDRA_TYPE.test(name); }

/** The last segment of a callee spelled `f` or `ns::f`; a member call is never a pseudo-op. */
function calleeLeaf(callee: any): string | null {
  const c = unparen(callee);
  if (c?.kind === NodeKind.Identifier && typeof c.name === 'string') return c.name;
  if (c?.kind === NodeKind.QualifiedId && typeof c.name?.name === 'string') return c.name.name;
  return null;
}

function typeLeaf(t: any): string | null {
  const n = t?.name;
  if (n?.kind === NodeKind.Identifier && typeof n.name === 'string') return n.name;
  if (n?.kind === NodeKind.QualifiedId && typeof n.name?.name === 'string') return n.name.name;
  return null;
}

/** The comment's words, without its opener. */
function commentBody(text: string): string {
  if (text.startsWith('//')) return text.slice(2).trimStart();
  if (text.startsWith('/*')) return text.slice(2).trimStart();
  return text.trimStart();
}

/** Files the rule does not apply to: hand-written support code and the pseudo-op definitions. */
function exempt(file: SourceFile): boolean {
  const p = file.path;
  return p === PLATFORM_HEADER || p.endsWith(`/${PLATFORM_HEADER}`) ||
    p.startsWith('support/') || p.includes('/support/');
}

/** Every function name the tree DECLARES outside the platform header - a real function, not notation. */
function declaredFunctionNames(files: SourceFile[]): Set<string> {
  const out = new Set<string>();
  for (const f of files) {
    if (f.path === PLATFORM_HEADER || f.path.endsWith(`/${PLATFORM_HEADER}`)) continue;
    const stack: ASTNode[] = [f.tu as ASTNode];
    while (stack.length) {
      const n: any = stack.pop();
      if (!n || typeof n !== 'object') continue;
      if (n.kind === NodeKind.FunctionDecl) {
        // `f`, `ns::f`, and a specialization `f<int>` or `C<A>::f`: the name declared is `f`.
        const leafOf = (nm: any): unknown => typeof nm === 'string' ? nm
          : nm?.kind === NodeKind.Identifier ? nm.name
          : nm?.kind === NodeKind.QualifiedId || nm?.kind === NodeKind.TemplateType ? leafOf(nm.name) : null;
        const leaf = leafOf(n.name);
        if (typeof leaf === 'string') out.add(leaf);
        continue;
      }
      // Declarations live at namespace, linkage and class scope; bodies hold none worth finding.
      if (n.kind === NodeKind.TranslationUnit || n.kind === NodeKind.NamespaceDecl ||
          n.kind === NodeKind.LinkageSpec) {
        for (const d of n.declarations ?? []) stack.push(d);
      } else if (n.kind === NodeKind.TemplateDecl) {
        stack.push(n.declaration);
      } else if (n.kind === NodeKind.StructDecl || n.kind === NodeKind.ClassDecl) {
        for (const m of n.members ?? []) stack.push(m);
      }
    }
  }
  return out;
}

export const ghidraArtifact: Check = {
  id: GHIDRA_ARTIFACT_CHECK_ID,
  blurb: 'decompiler notation in the tree (pseudo-ops, frame/register names, Ghidra types, WARNING) - counted, not baselined',
  run(ctx) {
    const out: Finding[] = [];
    const declared = declaredFunctionNames(ctx.tree.files);
    const fnOfBody = new Map<ASTNode, FunctionInfo>();
    for (const fn of ctx.tree.functions) if ((fn.node as any).body) fnOfBody.set((fn.node as any).body, fn);

    for (const file of ctx.tree.files) {
      if (exempt(file)) continue;
      const seenTrivia = new Set<object>();
      const add = (rule: GhidraArtifactRule, node: any, fn: FunctionInfo | null, what: string) => {
        out.push({
          check: GHIDRA_ARTIFACT_CHECK_ID, file: file.path, line: line(node), fn: fn?.qualifiedName,
          subject: rule, detail: what, sig: `${what} ${signature(node)}`,
        });
      };

      const stack: Array<[any, any, FunctionInfo | null]> = [[file.tu, null, null]];
      while (stack.length) {
        const [n, parent, outerFn] = stack.pop()!;
        if (!n || typeof n !== 'object') continue;
        const fn = fnOfBody.get(n) ?? outerFn;

        for (const t of [...(n.leadingTrivia ?? []), ...(n.trailingTrivia ?? [])]) {
          if (seenTrivia.has(t)) continue;
          seenTrivia.add(t);
          if (t.kind !== TriviaKind.LineComment && t.kind !== TriviaKind.BlockComment) continue;
          if (commentBody(t.text).startsWith('WARNING')) {
            let first = commentBody(t.text).split('\n')[0].trimEnd();
            if (first.endsWith('*/')) first = first.slice(0, -2).trimEnd();
            add('warning-comment', { location: t.location }, fn, first);
          }
        }

        switch (n.kind) {
          case NodeKind.CallExpr: {
            const leaf = calleeLeaf(n.callee);
            if (leaf && isPseudoOpName(leaf) && !declared.has(leaf)) add('pseudo-op-call', n, fn, leaf);
            break;
          }
          case NodeKind.Identifier: {
            const name = n.name;
            if (typeof name !== 'string') break;
            const isCallee = parent?.kind === NodeKind.CallExpr && unparen(parent.callee) === n;
            if (!isCallee) {
              if (name === 'FLOAT_UNKNOWN') add('pseudo-constant', n, fn, name);
              else if (name === 'NAN' && parent?.kind === NodeKind.UnaryExpr && parent.operator === '-') {
                add('pseudo-constant', parent, fn, '-NAN');
              }
            }
            if (isFrameName(name)) add('frame-name', n, fn, name);
            else if (isRegisterName(name)) add('register-name', n, fn, name);
            break;
          }
          case NodeKind.VariableDecl:
          case NodeKind.ParameterDecl: {
            // A fresh parse keeps a declarator's name as a string, not an Identifier node,
            // so the Identifier case never sees it.
            if (typeof n.name !== 'string') break;
            const name = declName(n);
            if (!name) break;
            if (isFrameName(name)) add('frame-name', n, fn, name);
            else if (isRegisterName(name)) add('register-name', n, fn, name);
            break;
          }
          case NodeKind.TypedefType: {
            const name = typeLeaf(n);
            if (name && isGhidraTypeName(name)) add('ghidra-type', n, fn, name);
            break;
          }
          case NodeKind.MemberExpr: {
            const m = n.member?.name;
            if (typeof m === 'string' && SUBPIECE_MEMBER.test(m)) add('subpiece-member', n, fn, m);
            break;
          }
          case NodeKind.FloatingLiteral: {
            const v = Math.abs(Number(n.value));
            if (v > 0 && v < FLT_MIN) add('denormal-literal', n, fn, String(n.raw ?? n.value));
            break;
          }
        }

        const kids = getChildren(n);
        for (let i = kids.length - 1; i >= 0; i--) if (kids[i]) stack.push([kids[i], n, fn]);
      }
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// The counted gate
// ---------------------------------------------------------------------------

/** Rule id -> the most findings the tree may carry. A rule absent here allows none. */
export type ArtifactAllowlist = Partial<Record<string, number>>;

export interface ArtifactGateRow {
  rule: string;
  count: number;
  allowed: number;
  /** count > allowed: the regen fails. */
  over: boolean;
  /** count < allowed: the allowance can be lowered to `count`. */
  slack: boolean;
}

/** Count findings per rule and judge them against the allowlist. Every rule is listed, even at 0. */
export function artifactGate(findings: Finding[], allow: ArtifactAllowlist): { rows: ArtifactGateRow[]; ok: boolean } {
  const counts = new Map<string, number>();
  for (const f of findings) {
    if (f.check !== GHIDRA_ARTIFACT_CHECK_ID) continue;
    counts.set(f.subject, (counts.get(f.subject) ?? 0) + 1);
  }
  const rules = [...new Set<string>([...GHIDRA_ARTIFACT_RULES, ...counts.keys(), ...Object.keys(allow)])];
  const rows = rules.map(rule => {
    const count = counts.get(rule) ?? 0;
    const allowed = allow[rule] ?? 0;
    return { rule, count, allowed, over: count > allowed, slack: count < allowed };
  });
  return { rows, ok: rows.every(r => !r.over) };
}

/**
 * Ghidra WARNING comments as facts, not comments.
 *
 * The decompiler writes `/* WARNING: ... *\/` where it gave up on something, or
 * just wants to say what it did. None of that is source code, and none of it may
 * reach the emitted tree. Some of it is a real defect signal though - a noreturn
 * into a function that returns, a truncated jumptable, a removed block - so it is
 * not thrown away either: each comment becomes one record, read here from the
 * decompiled text with the project's own lexer, and the codegen writes the
 * records to `warnings.tsv` beside the tree.
 *
 * Classification is a lookup by the fixed message PREFIX Ghidra prints. Each
 * template is either `informational` (Ghidra describing a choice it made that the
 * output already reflects) or `defect` (something the output may have lost). A
 * message no template knows is `unclassified`, which counts as a defect: a new
 * Ghidra message is not presumed harmless.
 *
 * The comment itself is removed from the AST by `warning-comment-strip`, the last
 * pass. It runs last because two earlier passes still READ these comments:
 * `indirect-call-cleanup` (jumptable warnings) and `goto-cleanup` (the noreturn
 * warning drives its tail classification).
 */

import type { ASTNode } from '../../../ast/nodes.js';
import { Lexer } from '../../../lexer/lexer.js';
import { TokenKind } from '../../../lexer/token.js';
import { TriviaKind, type Trivia, type TokenWithTrivia } from '../../../lexer/trivia.js';
import { createTransformer, updateNode, type Transformer } from '../../transformer.js';
import type { TransformPlugin } from '../types.js';

export type WarningClass = 'informational' | 'defect';

export interface WarningTemplate {
  /** The message text Ghidra starts the warning with, after `WARNING: `. */
  prefix: string;
  kind: string;
  class: WarningClass;
}

/** The marker every Ghidra warning line starts with. `WARNING (jumptable): ` is the one variant. */
const WARNING_MARKERS = ['WARNING: ', 'WARNING (jumptable): '] as const;

/**
 * Ghidra's warning templates, by the fixed text each message starts with.
 * `Subroutine does not return` is listed as informational here; whether a given
 * instance is depends on the callee, see `classifyWarning`.
 */
export const WARNING_TEMPLATES: readonly WarningTemplate[] = [
  // Informational: what Ghidra did, already visible in the output or irrelevant to it.
  { prefix: 'Subroutine does not return', kind: 'noreturn', class: 'informational' },
  { prefix: 'Switch is manually overridden', kind: 'switch-override', class: 'informational' },
  { prefix: 'Inlined function: ', kind: 'inlined-function', class: 'informational' },
  { prefix: 'This is an inlined function', kind: 'inlined-function-marker', class: 'informational' },
  { prefix: 'Function: ', kind: 'replaced-with-injection', class: 'informational' },
  { prefix: 'Enum "', kind: 'enum-duplicate-names', class: 'informational' },
  { prefix: 'Unknown calling convention', kind: 'unknown-calling-convention', class: 'informational' },
  { prefix: 'Variable defined which should be unmapped', kind: 'unmapped-variable', class: 'informational' },
  { prefix: 'Globals starting with ', kind: 'globals-overlap', class: 'informational' },
  { prefix: 'Restarted to delay deadcode elimination', kind: 'deadcode-restart', class: 'informational' },
  // Defects: the output may be missing code, a value or a type.
  { prefix: 'Could not inline here', kind: 'could-not-inline', class: 'defect' },
  { prefix: 'Could not recover jumptable', kind: 'jumptable-unrecovered', class: 'defect' },
  { prefix: 'Treating indirect jump as call', kind: 'indirect-jump-as-call', class: 'defect' },
  { prefix: 'Jumptable at ', kind: 'jumptable-sanity', class: 'defect' },
  { prefix: 'Sanity check requires truncation of jumptable', kind: 'jumptable-truncated', class: 'defect' },
  { prefix: 'Could not find normalized switch variable', kind: 'switch-variable-unmatched', class: 'defect' },
  { prefix: 'Removing unreachable block', kind: 'unreachable-block-removed', class: 'defect' },
  { prefix: 'Bad instruction', kind: 'bad-instruction', class: 'defect' },
  { prefix: 'Unable to track spacebase', kind: 'spacebase-untracked', class: 'defect' },
  { prefix: 'Type propagation algorithm not settling', kind: 'type-propagation-unsettled', class: 'defect' },
  { prefix: 'Possible PIC construction', kind: 'pic-construction', class: 'defect' },
  { prefix: 'Unable to use type for symbol', kind: 'unusable-symbol-type', class: 'defect' },
  { prefix: 'Read-only address ', kind: 'readonly-address-written', class: 'defect' },
  { prefix: 'Control flow encountered bad instruction data', kind: 'bad-instruction-data', class: 'defect' },
  { prefix: 'Instruction at ', kind: 'overlapping-instruction', class: 'defect' },
];

/**
 * Callees that really do not return. A noreturn warning before one of these is the
 * decompiler being right; before anything else it means Ghidra believes a function
 * is noreturn that may not be, and truncated the code after the call
 * (`InitDrlgAct` in `EnsureDrlgActLoaded`).
 */
export const TERMINAL_CALLEES: ReadonlySet<string> = new Set([
  'exit', '_exit', '_Exit', 'quick_exit', 'abort',
  'ExitProcess', 'ExitThread', 'TerminateProcess',
  '__break', '__halt', 'halt_baddata',
  'ERROR_UnrecoverableInternalError_Halt',
  // The MSVC runtime's own spellings of the same exits.
  '__exit', '_abort', '___crtExitProcess', 'terminate', '__invoke_watson',
  '_CxxThrowException', '__CxxThrowException_8',
]);

export interface WarningFact {
  kind: string;
  class: WarningClass;
  /** The message after the `WARNING: ` marker, whitespace collapsed. */
  detail: string;
  /** For `noreturn`: the callee the warning stands before, if one was found. */
  callee?: string;
}

/** One comment line without its indentation and a block comment's leading `*`. */
function commentLine(raw: string): string {
  const t = raw.trim();
  return t.startsWith('*') && !t.startsWith('*/') ? t.slice(1).trim() : t;
}

/** Whitespace runs collapsed to one space. */
function collapse(s: string): string {
  return s.split(/\s+/).filter(Boolean).join(' ');
}

/** The message after the marker, or null when the line is not a Ghidra warning. */
function warningMessage(line: string): string | null {
  const t = commentLine(line);
  for (const m of WARNING_MARKERS) {
    if (t.startsWith(m)) return t.slice(m.length).trim();
  }
  return null;
}

/** Look a message up in the template table. */
export function classifyWarning(message: string, callee?: string): Omit<WarningFact, 'detail'> {
  const tpl = WARNING_TEMPLATES.find(t => message.startsWith(t.prefix));
  if (!tpl) return { kind: 'unclassified', class: 'defect' };
  if (tpl.kind === 'noreturn') {
    const terminal = callee !== undefined && TERMINAL_CALLEES.has(callee);
    return terminal
      ? { kind: 'noreturn', class: 'informational', callee }
      : { kind: 'noreturn-unknown-callee', class: 'defect', ...(callee !== undefined ? { callee } : {}) };
  }
  return { kind: tpl.kind, class: tpl.class };
}

/** The text inside a comment trivia, without its markers. */
function commentBody(t: Trivia): string | null {
  if (t.kind === TriviaKind.BlockComment) return t.text.slice(2, t.text.endsWith('*/') ? -2 : undefined);
  if (t.kind === TriviaKind.LineComment) return t.text.slice(2);
  return null;
}

/** True when a comment trivia carries any Ghidra warning line. */
export function isWarningComment(t: Trivia): boolean {
  const body = commentBody(t);
  if (body === null) return false;
  return body.split('\n').some(l => warningMessage(l) !== null);
}

/**
 * The callee of the first call at or after token `from`, within the same block.
 * `a = Ns::F(x)` gives `F`; `exit(-1)` gives `exit`. Statements before the call are
 * skipped: Ghidra prints the warning at the CALL instruction, and a store that
 * belongs to the same instruction group can be printed first
 * (`uStack00000004 = 0x4b6ee3; _exit(-1);`).
 */
function nextCallee(tokens: TokenWithTrivia[], from: number): string | undefined {
  for (let i = from; i < tokens.length; i++) {
    const k = tokens[i].token.kind;
    if (k === TokenKind.RightBrace || k === TokenKind.LeftBrace || k === TokenKind.EOF) return undefined;
    if (k === TokenKind.LeftParen && i > from && tokens[i - 1].token.kind === TokenKind.Identifier) {
      return tokens[i - 1].token.text;
    }
  }
  return undefined;
}

/**
 * Every Ghidra warning in one function's decompiled text - the header comments
 * before the signature as well as the ones inside the body - in text order.
 *
 * A text the lexer cannot read (a plate comment with a stray `*\/` in it) yields one
 * `unreadable-text` defect instead of silently yielding nothing.
 */
export function collectWarningFacts(decompiled: string): WarningFact[] {
  let tokens: TokenWithTrivia[];
  try {
    tokens = new Lexer(decompiled).tokenizeWithTrivia();
  } catch (e) {
    const msg = collapse(e instanceof Error ? e.message : String(e));
    return [{ kind: 'unreadable-text', class: 'defect', detail: `lexer: ${msg}` }];
  }
  const facts: WarningFact[] = [];
  const read = (t: Trivia, calleeFrom: number) => {
    const body = commentBody(t);
    if (body === null) return;
    for (const raw of body.split('\n')) {
      const msg = warningMessage(raw);
      if (msg === null) continue;
      const detail = collapse(msg);
      const callee = detail.startsWith('Subroutine does not return') ? nextCallee(tokens, calleeFrom) : undefined;
      facts.push({ ...classifyWarning(detail, callee), detail });
    }
  };
  for (let i = 0; i < tokens.length; i++) {
    for (const t of tokens[i].leadingTrivia) read(t, i);
    for (const t of tokens[i].trailingTrivia) read(t, i + 1);
  }
  return facts;
}

// ============================================
// THE STRIP PASS
// ============================================

function withoutWarnings(trivia: Trivia[] | undefined): Trivia[] | undefined {
  if (!trivia || trivia.length === 0) return trivia;
  const kept = trivia.filter(t => !isWarningComment(t));
  return kept.length === trivia.length ? trivia : kept;
}

function createWarningCommentStripTransformer(): Transformer {
  return createTransformer({
    visitNode(node: ASTNode): ASTNode | undefined {
      const n = node as ASTNode & { leadingTrivia?: Trivia[]; trailingTrivia?: Trivia[] };
      const lead = withoutWarnings(n.leadingTrivia);
      const trail = withoutWarnings(n.trailingTrivia);
      if (lead === n.leadingTrivia && trail === n.trailingTrivia) return undefined;
      return updateNode(node, { leadingTrivia: lead ?? [], trailingTrivia: trail ?? [] });
    },
  });
}

export const warningCommentStripPlugin: TransformPlugin = {
  id: 'warning-comment-strip',
  name: 'Warning Comment Strip',
  description: 'Removes Ghidra WARNING comments from the AST; the codegen records them in warnings.tsv instead',
  version: '1.0.0',
  defaultEnabled: true,
  // Last of all: indirect-call-cleanup (5) and goto-cleanup (55) read these comments.
  priority: 990,
  tags: ['core', 'cleanup', 'ghidra'],
  createTransformer: createWarningCommentStripTransformer,
};

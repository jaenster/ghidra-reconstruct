/**
 * "Which of these ~20,000 names does this file REFERENCE?" — answered in one pass.
 *
 * The include-dependency feedback in `generateFilesForFunctions` asks, for every
 * generated .cpp, which of ~15k function names and ~5k type names it uses, and
 * adds the declaring header of each. The answer has to be by WHOLE IDENTIFIER. It
 * used to be `text.includes(name)`, and a substring is not a reference: the old
 * name `ARCHIVE_OpenD2File` matched inside every call to `ARCHIVE_OpenD2FileWrap`
 * and pulled a header DataTbls.cpp never needed - and a name in a comment or a
 * string literal pulled one too.
 *
 * So the file is lexed with the project's own C++ lexer, once, and a needle
 * matches when it is one of the file's Identifier TOKENS. Comments, string and
 * character literals and preprocessor lines are trivia or literals to the lexer
 * and never produce an Identifier, so a name that only appears there is not a use.
 *
 * Needles that are not a single identifier (a name with `::`, a space, a `<`)
 * cannot be one token; they keep the plain substring scan, as before.
 */

import { Lexer, TokenKind } from '@ghidra-mcp/cpp-parser';

function isIdentifierChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95;
}

function isPureIdentifier(s: string): boolean {
  if (!s.length || (s.charCodeAt(0) >= 48 && s.charCodeAt(0) <= 57)) return false;
  for (let i = 0; i < s.length; i++) if (!isIdentifierChar(s.charCodeAt(i))) return false;
  return true;
}

export interface References {
  /** Every Identifier token. */
  identifiers: Set<string>;
  /** name -> each `A::B::name` spelling written with at least one qualifier. */
  qualified: Map<string, Set<string>>;
}

/**
 * The names a C++ text references, from the project's lexer. A text the lexer
 * refuses falls back to a character scan for identifier runs and `::` chains -
 * still whole names, but without the lexer's knowledge of comments and literals -
 * so a lexer gap can only ADD includes, never drop one a reference needs.
 */
export function scanReferences(text: string): References {
  const identifiers = new Set<string>();
  const qualified = new Map<string, Set<string>>();
  const note = (chain: string[]) => {
    if (chain.length < 2) return;
    const name = chain[chain.length - 1];
    let q = qualified.get(name);
    if (!q) qualified.set(name, (q = new Set()));
    q.add(chain.join('::'));
  };
  let words: Array<{ text: string; scope: boolean }>;
  try {
    const tokens = new Lexer(text, { preserveTrivia: false }).tokenize();
    words = [];
    for (const t of tokens) {
      if (t.kind === TokenKind.Identifier) words.push({ text: t.text, scope: false });
      else if (t.kind === TokenKind.ColonColon) words.push({ text: '::', scope: true });
      else words.push({ text: '', scope: false });
    }
  } catch {
    words = [];
    for (let i = 0; i < text.length;) {
      const c = text.charCodeAt(i);
      if (isIdentifierChar(c)) {
        let j = i;
        while (j < text.length && isIdentifierChar(text.charCodeAt(j))) j++;
        words.push({ text: text.slice(i, j), scope: false });
        i = j;
      } else if (c === 58 && text.charCodeAt(i + 1) === 58) {
        words.push({ text: '::', scope: true });
        i += 2;
      } else {
        if (c > 32) words.push({ text: '', scope: false });
        i++;
      }
    }
  }
  let chain: string[] = [];
  let expectName = true;
  for (const w of words) {
    if (w.scope) { if (expectName) chain = []; expectName = true; continue; }
    if (w.text && isPureIdentifier(w.text)) {
      identifiers.add(w.text);
      if (!expectName) { note(chain); chain = []; }
      chain.push(w.text);
      expectName = false;
      continue;
    }
    note(chain);
    chain = [];
    expectName = true;
  }
  note(chain);
  return { identifiers, qualified };
}

export class NeedleIndex {
  private readonly identifiers = new Set<string>();
  private readonly others: string[] = [];

  constructor(needles: Iterable<string>) {
    for (const needle of needles) {
      if (isPureIdentifier(needle)) this.identifiers.add(needle);
      // `''.includes('')` is true for every text; nothing sane produces one, but
      // keeping it on the substring path keeps the predicate honest if it does.
      else if (!this.others.includes(needle)) this.others.push(needle);
    }
  }

  /**
   * Every registered needle the text references: an identifier needle that is one
   * of the text's Identifier tokens, or any other needle that occurs as a substring.
   */
  matchesIn(text: string, refs: References = scanReferences(text)): Set<string> {
    const found = new Set<string>();
    for (const id of refs.identifiers) if (this.identifiers.has(id)) found.add(id);
    for (const needle of this.others) {
      if (text.includes(needle)) found.add(needle);
    }
    return found;
  }
}

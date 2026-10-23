/**
 * What of a Ghidra plate comment reaches the emitted code.
 *
 * A plate is written by people and by tools. The tools leave templates in it:
 * `batch_rename` writes an `@function/@address/@date/@calling/@params/@description` header,
 * the 1.14d reverse team's old plates carry a "Diablo 2 1.14d reverse team" banner, a
 * blizzhackers.dev link and a `Function:/Address:/Date:/Last editor:` (or `@Author:/@Date:`)
 * block, and Ghidra appends a "custom registers" warning with one `[type name@REG:size]` line
 * per parameter. None of these says what the code does: the name, the address and the
 * signature are already in the emitted declaration, and the dates and editors are history.
 * So every line a rule below matches is dropped, and every other line - the text a person
 * wrote about the function - is kept as it is. A plate left with nothing emits nothing.
 *
 * The plate is read as lines with one piece of structure: an `@params` header owns the
 * indented `name: STORAGE:size (type)` lines under it. That block is dropped whole; it is
 * a stale copy of the parameter storage (it can still say EAX for a function that has since
 * become a stack `__cdecl`), and the signature is the truth.
 *
 * `@description` is a wrapper, not content: `batch_rename` buries the original plate text
 * inside it, so it is unwrapped before the rules run and its text is judged like any other.
 */

/** One kind of template line, named so a reader can tell what is dropped and why. */
export interface PlateLineRule {
  id: string;
  /** Why a line of this kind says nothing about the code. */
  why: string;
  test(trimmed: string): boolean;
}

/** The reverse team's banner, alone on a line or leading a sentence of real text. */
const REVERSE_TEAM_BANNER = /^Diablo 2 1\.14d reverse team\.?\s*/i;

/** A note that the plate once had an `@Author` line; it says nothing about the code. */
const PRIOR_AUTHOR_NOTE = /\s*Has a prior per-function @Author annotation\.?/i;

export const PLATE_LINE_RULES: readonly PlateLineRule[] = [
  {
    id: 'template-tag',
    why: 'batch_rename header and reverse-team header tags: name, address, date, convention, author, parameter list - all in the declaration or history',
    test: t => /^@(function|address|date|calling|params|description|author)\b/i.test(t),
  },
  {
    id: 'sourcefile-basis',
    why: 'the evidence behind @sourcefile, not a fact about the code; @sourcefile itself stays',
    test: t => /^@sourcefile-basis\b/i.test(t),
  },
  {
    id: 'reverse-team-banner',
    why: 'a credit banner on every plate the reverse team touched',
    test: t => REVERSE_TEAM_BANNER.test(t) && t.replace(REVERSE_TEAM_BANNER, '') === '',
  },
  {
    id: 'url',
    why: 'a bare link (the reverse team plates link blizzhackers.dev)',
    test: t => /^https?:\/\/\S+$/.test(t),
  },
  {
    id: 'editor-block',
    why: 'the reverse team header block: Function/Address/Date/Last editor/Author, each a single value',
    test: t =>
      /^Function\s*:\s*[A-Za-z_][\w:~<>]*$/.test(t) ||
      /^Address\s*:\s*(Game(\.exe)?\.)?(ram:)?(0x)?[0-9A-Fa-f]{6,8}$/.test(t) ||
      /^Date\s*:\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}$/.test(t) ||
      /^(Last editor|Author)\s*:\s*\S+$/i.test(t),
  },
  {
    id: 'called-from',
    why: 'a FUN_ cross-reference line; the call graph is in the code',
    test: t => /^Called from\s*:?\s*FUN_[0-9a-fA-F]+$/i.test(t),
  },
  {
    id: 'custom-register-warning',
    why: 'Ghidra\'s "custom registers" warning and its [type name@REG:size] lines; the signature carries the storage',
    test: t => t === 'Function uses custom registers for function arguments!' || /^\[.*@.*:\d+\]$/.test(t),
  },
  {
    id: 'stale-edit-note',
    why: 'a tool\'s note to itself about an earlier edit of the plate, with nothing about the code in it',
    test: t => /^Already has a meaningful @description \(applied via previous session\)\.?$/i.test(t),
  },
];

/**
 * `  name: ECX:4 (int32_t)`, `  name: Stack[0x4]:2 (uint16_t)`, `  name: EDX:4,EAX:4 (ulonglong)` -
 * a line of an @params block.
 */
const STORAGE_PIECE = String.raw`(\w+|Stack\[-?0x[0-9a-fA-F]+\]):\d+`;
const PARAMS_ENTRY = new RegExp(String.raw`^\s+[A-Za-z_]\w*\s*:\s*${STORAGE_PIECE}(,${STORAGE_PIECE})*(\s*\(.*\))?\s*$`);

/** The rule a trimmed plate line falls under, or null when it is text to keep. */
export function plateLineRule(trimmed: string): PlateLineRule | null {
  for (const r of PLATE_LINE_RULES) if (r.test(trimmed)) return r;
  return null;
}

/**
 * The lines of a plate a reader of the code needs, in order, trimmed of template. Blank
 * lines go too: the emitter writes one `//` line per kept line.
 */
export function stripPlateTemplate(rawLines: readonly string[]): string[] {
  const out: string[] = [];
  let inParams = false;
  for (const raw of rawLines) {
    if (inParams) {
      if (PARAMS_ENTRY.test(raw)) continue;
      inParams = false;
    }
    let line = raw;
    const described = line.match(/^\s*@description\s+(.*)$/i);
    if (described) line = described[1];
    let trimmed = line.trim();
    if (/^@params\b/i.test(trimmed)) { inParams = true; continue; }
    if (!trimmed) continue;
    if (plateLineRule(trimmed)) continue;
    // A banner or an @Author note fused onto real text: keep the text.
    if (REVERSE_TEAM_BANNER.test(trimmed) || PRIOR_AUTHOR_NOTE.test(trimmed)) {
      const indent = line.match(/^\s*/)![0];
      line = indent + trimmed.replace(REVERSE_TEAM_BANNER, '').replace(PRIOR_AUTHOR_NOTE, '').trim();
      trimmed = line.trim();
      if (!trimmed || plateLineRule(trimmed)) continue;
    }
    // A `param_N:` line outside an @params header is the same template, half-copied.
    if (/^param_\d+\s*:/.test(trimmed)) continue;
    out.push(line);
  }
  return out;
}

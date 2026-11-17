/**
 * The function-local statics a kept body must declare.
 *
 * The generator opens a body with the data its function owns (globals-header.ts,
 * generateStaticLocalsBlock): `static T x = ...; D2_STATIC_GUARD(x, "...");`, one per
 * line, after the `// Static local variables` comment. Which data a function owns is
 * decided for the whole program from every body that names it, so it moves without the
 * body changing: a datum the stored body named as a file-scope global can be the
 * function's own static now, and then nothing else in the tree defines it. Printed
 * again as it was, the stored body names it and declares nothing (PROPERTIESFUNCTIONS,
 * 007462f8, in ITEMMOD_ApplyPropertyToUnitStatsExpansion 0065fd70: undeclared at
 * Game.exe v2110). The other way round, a stored body that still declares a static
 * the tree now defines outside the function would define a second object of that name.
 *
 * So a kept body takes the fresh body's static block when the fresh one declares every
 * static the stored one does, and is refused when it declares one the fresh body no
 * longer does.
 */
import { TokenKind } from '@ghidra-mcp/cpp-parser';
import { lexTokens, type Tok } from './scan.js';

export interface StaticBlock {
  /** Offset of the block in the text: its comment when it has one, else its first `static`. */
  start: number;
  /** Offset one past its last statement. */
  end: number;
  /** The names it declares, in order. */
  names: string[];
  /** Each declaration's text with its guard, the name spelled `@`: what a rename leaves alone. */
  shapes: string[];
}

const BLOCK_COMMENT = '// Static local variables';
/** `D2_STATIC_GUARD`, and `D2_STATIC_GUARD_BSS` for a zero-initialised one. */
const isGuard = (t: string) => t === 'D2_STATIC_GUARD' || t === 'D2_STATIC_GUARD_BSS';

/** The end of the statement starting at token `i`: the index of its `;` at depth 0. */
function statementEnd(toks: Tok[], i: number): number {
  let depth = 0;
  for (let k = i; k < toks.length; k++) {
    const t = toks[k].text;
    if (t === '(' || t === '[' || t === '{') depth++;
    else if (t === ')' || t === ']' || t === '}') depth--;
    else if (t === ';' && depth === 0) return k;
  }
  return -1;
}

/** The name a `static` declaration from token `i` to `end` declares. */
function declaredName(toks: Tok[], i: number, end: number): string | undefined {
  let name: string | undefined;
  for (let k = i + 1; k < end; k++) {
    const t = toks[k];
    // `(` opens a declarator only before a pointer or reference: `int (*gpfn[2])(int)`.
    if (t.text === '(' && (toks[k + 1]?.text === '*' || toks[k + 1]?.text === '&')) continue;
    if (t.text === '=' || t.text === '[' || t.text === '(') break;
    if (t.kind === TokenKind.Identifier) name = t.text;
  }
  return name;
}

/**
 * The static block at the top of a body: `text` holds a body from its `{` (a kept body)
 * or a whole definition, `bodyStart` is the offset of the body's `{`.
 */
export function staticBlock(text: string, bodyStart: number): StaticBlock | undefined {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  let i = toks.findIndex(t => t.start === bodyStart && t.text === '{');
  if (i < 0) return undefined;
  i++;
  const names: string[] = [];
  const shapes: string[] = [];
  let start = -1;
  let end = -1;
  while (i < toks.length && toks[i].text === 'static') {
    const semi = statementEnd(toks, i);
    if (semi < 0) break;
    const name = declaredName(toks, i, semi);
    if (!name) break;
    if (start < 0) {
      const comment = toks[i].lead.find(t => t.text.startsWith(BLOCK_COMMENT));
      start = comment ? comment.start : toks[i].start;
    }
    const first = i;
    end = toks[semi].end;
    i = semi + 1;
    if (i < toks.length && isGuard(toks[i].text)) {
      const g = statementEnd(toks, i);
      if (g < 0) break;
      end = toks[g].end;
      i = g + 1;
    }
    names.push(name);
    shapes.push(toks.slice(first, i).map(t => (t.kind === TokenKind.Identifier && t.text === name ? '@'
      : t.kind === TokenKind.StringLiteral && t.text.endsWith(`::${name}"`) ? `${t.text.slice(0, -name.length - 1)}@"` : t.text)).join(' '));
  }
  return names.length > 0 ? { start, end, names, shapes } : undefined;
}

/** Every identifier the text names. */
function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of lexTokens(text) ?? []) if (t.kind === TokenKind.Identifier) out.add(t.text);
  return out;
}

/** `text` with every name in `renames` spelled anew, where it is not a member or qualified. */
function renameIdentifiers(text: string, renames: Map<string, string>): string | undefined {
  const toks = lexTokens(text);
  if (!toks) return undefined;
  let out = text;
  for (let k = toks.length - 1; k >= 0; k--) {
    const t = toks[k];
    if (t.kind === TokenKind.StringLiteral) {
      // The guard's label, `"NS::Fn::name"`.
      for (const [from, to] of renames) {
        if (t.text.endsWith(`::${from}"`)) out = out.slice(0, t.start) + `${t.text.slice(0, -from.length - 1)}${to}"` + out.slice(t.end);
      }
      continue;
    }
    const to = t.kind === TokenKind.Identifier ? renames.get(t.text) : undefined;
    if (!to) continue;
    const before = toks[k - 1]?.text;
    if (before === '.' || before === '->' || before === '::') continue;
    out = out.slice(0, t.start) + to + out.slice(t.end);
  }
  return out;
}

/**
 * A kept body (`kept`, from its `{`) with the static block the fresh definition
 * (`fresh`, its body's `{` at `freshBodyStart`) declares, or why it cannot be kept.
 *
 * A static the stored body declares and the fresh one declares under another name - the
 * same declaration in the same place, the name aside (gnGfxCofCacheFlags, now gnGfxMemory,
 * in GFX_GetGfxMemory 0046f980) - is the same datum renamed: the kept body takes the name.
 */
export function carryStaticLocals(kept: string, fresh: string, freshBodyStart: number): { text?: string; error?: string } {
  let sb = staticBlock(kept, 0);
  const fb = staticBlock(fresh, freshBodyStart);
  const now = new Set(fb?.names ?? []);
  const renames = new Map<string, string>();
  if (sb && fb) {
    sb.names.forEach((n, k) => {
      const to = fb.names[k];
      if (now.has(n) || to === undefined || sb!.names.includes(to) || fb.shapes[k] !== sb!.shapes[k]) return;
      renames.set(n, to);
    });
  }
  if (renames.size > 0) {
    const named = identifiers(kept);
    const clash = [...renames.values()].filter(n => named.has(n));
    if (clash.length > 0) return { error: `the stored body's static is renamed ${clash.join(', ')}, a name it already uses` };
    const text = renameIdentifiers(kept, renames);
    if (text === undefined) return { error: 'the stored body does not lex' };
    kept = text;
    sb = staticBlock(kept, 0);
  }
  const stored = sb?.names ?? [];
  const gone = stored.filter(n => !now.has(n));
  if (gone.length > 0) return { error: `the stored body declares static ${gone.join(', ')}, which the function no longer owns` };
  const missing = [...now].filter(n => !stored.includes(n));
  if (missing.length === 0 || !fb) return { text: kept };
  // Only what the stored body names: a static the fresh body declares for a reference
  // the stored body does not make changes nothing it compiles.
  const named = identifiers(kept);
  if (!missing.some(n => named.has(n))) return { text: kept };
  const block = fresh.slice(fb.start, fb.end);
  if (sb) return { text: kept.slice(0, sb.start) + block + kept.slice(sb.end) };
  const nl = kept.indexOf('\n');
  if (nl < 0) return { error: `cannot place the static block of ${missing.join(', ')} in a one-line body` };
  return { text: `${kept.slice(0, nl + 1)}    ${block}\n\n${kept.slice(nl + 1)}` };
}

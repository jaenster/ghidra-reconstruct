/**
 * Re-spell a stored body for the tree it lands in.
 *
 * Every site of the stored text has the binding it was captured with. Under the new index
 * each binding is spelled again: a function or global by its address's current name, a field
 * by the name at its (struct, offset), an enum constant by its value, a parameter by its
 * identity in the current signature (storage and name, params.ts). A call whose callee's
 * parameter list changed has its arguments re-ordered by the callee's parameter identity. The edits are spliced into the stored text at the
 * parser's locations, so everything that is not a reference stays byte for byte.
 *
 * Anything that cannot be spelled - an address no longer a function, a field offset gone, a
 * type gone, the enclosing function's arity changed, a callee that gained a parameter - makes
 * the whole body unresolvable, with the reasons; the caller falls back to the new body.
 */
import { isIdentity, matchParams, paramIds, type ParamId } from './params.js';
import { bindingKey, typeRefString, type Binding, type SiteScan } from './refs.js';
import { sameResolved, type Resolved, type SymbolIndex } from './symbol-index.js';
import { misparsedTypes } from './scan.js';

export interface RewriteContext {
  index: SymbolIndex;
  /** The scope the body is printed in: enclosing namespaces plus the declarator's qualifier. */
  scope: string[];
  /** The current signature's parameter names, in order. */
  params: string[];
  /**
   * Where each parameter of the stored signature is in the current one (params.ts
   * matchParams). Without it a parameter keeps its position and the arity must not change.
   */
  paramMap?: number[];
  /** Spellings the fresh generator output uses, by binding key: preferred when they resolve. */
  preferred?: Map<string, string>;
  /** A scope per site, where sites sit in different namespaces (a whole hand file). */
  scopeOf?: (site: number) => string[];
  /** Leave a site that cannot be spelled as it is and go on (hand files): errors are reported, not fatal. */
  partial?: boolean;
}

export interface RewriteResult {
  text?: string;
  errors: string[];
  /** Sites whose spelling changed, `old -> new`. */
  renames: string[];
}

interface Edit { start: number; end: number; text?: string; call?: { args: Array<[number, number]>; order: number[] } }

function splitSpelling(s: string): { parts: string[]; isGlobal: boolean } {
  const isGlobal = s.startsWith('::');
  return { parts: (isGlobal ? s.slice(2) : s).split('::'), isGlobal };
}

/** The shortest qualification of `qname` that resolves to `want` from `scope`. */
function minimalSpelling(index: SymbolIndex, qname: string, want: Resolved, scope: string[]): string | undefined {
  const parts = qname.split('::');
  for (let k = parts.length - 1; k >= 0; k--) {
    const cand = parts.slice(k);
    if (sameResolved(index.resolve(cand, false, scope), want)) return cand.join('::');
  }
  if (sameResolved(index.resolve(parts, true, scope), want)) return `::${qname}`;
  return undefined;
}

function resolvedOf(b: Binding): Resolved | undefined {
  switch (b.k) {
    case 'fn': return b.x ? { k: 'fn', a: b.a, x: true } : { k: 'fn', a: b.a };
    case 'gl': return { k: 'gl', a: b.a };
    case 'en': return { k: 'en', e: b.e, v: b.v };
    case 'ty': return { k: 'ty', q: b.q };
    default: return undefined;
  }
}

/** The name of the field at (struct, offset), preferring `old` when it is still one there. */
function fieldName(index: SymbolIndex, s: string, o: number, old: string): { name?: string; error?: string } {
  const st = index.structs.get(s);
  if (!st) return { error: `struct ${s} gone` };
  const at = st.fields.filter(f => f.offset === o);
  if (at.some(f => f.name === old)) return { name: old };
  if (at.length === 1) return { name: at[0].name };
  if (at.length === 0) return { error: `${s} has no field at +0x${o.toString(16)} (was ${old})` };
  return { error: `${s}+0x${o.toString(16)} is ambiguous (${at.map(f => f.name).join(', ')}; was ${old})` };
}

/**
 * Re-spell `scan`'s body (the stored definition text) with `bindings` under `ctx`. The
 * result is the body only, from its `{` to its `}`.
 */
export function rewriteBody(text: string, scan: SiteScan, bindings: Array<Binding | undefined>, ctx: RewriteContext): RewriteResult {
  const errors: string[] = [];
  const renames: string[] = [];
  const edits: Edit[] = [];
  const { index } = ctx;

  scan.sites.forEach((site, i) => {
    const b = bindings[i];
    if (!b) return;
    const scope = ctx.scopeOf ? ctx.scopeOf(i) : ctx.scope;
    const old = text.slice(site.start, site.end);
    let spelled: string | undefined;
    switch (b.k) {
      case 'param': {
        if (ctx.params.length !== scan.params.length) {
          errors.push(`arity changed: ${scan.params.length} -> ${ctx.params.length} parameters`);
          return;
        }
        spelled = ctx.params[ctx.paramMap ? ctx.paramMap[b.i] : b.i];
        if (!spelled) { errors.push(`parameter ${b.i} has no name now`); return; }
        break;
      }
      case 'fd': {
        const r = fieldName(index, b.s, b.o, site.parts[0]);
        if (r.error) { errors.push(r.error); return; }
        spelled = r.name;
        const now = typeRefString(index.structs.get(b.s)?.fields.find(f => f.offset === b.o && f.name === r.name)?.type);
        if (b.t && now && now !== b.t) { errors.push(`field ${b.s}::${site.parts[0]} retyped: ${b.t} -> ${now}`); return; }
        break;
      }
      case 'fdc': {
        // Every candidate owner that still exists must agree on the new name.
        const names = new Set<string>();
        for (const [s, o] of b.c) {
          const r = fieldName(index, s, o, site.parts[0]);
          if (r.name) names.add(r.name);
        }
        if (names.size === 0) { errors.push(`no owner of field ${site.parts[0]} survives`); return; }
        if (names.size > 1) {
          if (names.has(site.parts[0])) { errors.push(`field ${site.parts[0]}: owners disagree (${[...names].join(', ')})`); return; }
          errors.push(`field ${site.parts[0]}: owners disagree (${[...names].join(', ')})`);
          return;
        }
        spelled = [...names][0];
        break;
      }
      default: {
        const want = resolvedOf(b)!;
        if (b.k === 'fn' && b.a.some(a => !index.fnByAddr.has(a))) { errors.push(`function ${b.a.join('/')} (${old}) gone`); return; }
        if (b.k === 'gl' && !index.glByAddr.has(b.a)) {
          // A global the index cannot see (no globals index in this tree): keep the spelling
          // when it still resolves to nothing else.
          if (index.glByAddr.size === 0) return;
          errors.push(`global ${b.a} (${old}) gone`);
          return;
        }
        if (b.k === 'gl' && b.t) {
          const now = typeRefString(index.glByAddr.get(b.a)?.type);
          if (now && now !== b.t) { errors.push(`global ${old} retyped: ${b.t} -> ${now}`); return; }
        }
        if (b.k === 'fn' && b.a.length === 1) {
          const now = index.fnByAddr.get(b.a[0]);
          // Types an older scanner read off an attribute group are no evidence either way.
          const known = !misparsedTypes(b.pt);
          if (known && b.rt !== undefined && now?.retText !== undefined && now.retText !== b.rt) { errors.push(`callee ${old} returns ${now.retText}, was ${b.rt}`); return; }
          if (known && b.pt && now?.paramTypes && b.p && now.params) {
            // Compared parameter by parameter, wherever each one is now.
            const m = b.p.length === now.params.length ? matchParams(paramIds(b.p, b.ps), paramIds(now.params, now.storage)) : undefined;
            for (let k = 0; k < b.pt.length; k++) {
              const j = m && 'map' in m ? m.map[k] : k;
              if (j < now.paramTypes.length && b.pt[k] !== now.paramTypes[j]) { errors.push(`callee ${old} parameter ${now.params[j] || j} retyped: ${b.pt[k]} -> ${now.paramTypes[j]}`); return; }
            }
          }
        }
        if (b.k === 'ty' && !index.types.has(b.q)) { errors.push(`type ${b.q} gone`); return; }
        if (b.k === 'en' && !index.enumByValue.has(`${b.e}\0${b.v}`)) { errors.push(`enum ${b.e} has no ${b.v} (was ${old})`); return; }
        const oldSp = splitSpelling(old);
        if (sameResolved(index.resolve(oldSp.parts, oldSp.isGlobal, scope), want)) spelled = old;
        else {
          const pref = ctx.preferred?.get(bindingKey(b));
          if (pref) {
            const p = splitSpelling(pref);
            if (sameResolved(index.resolve(p.parts, p.isGlobal, scope), want)) spelled = pref;
          }
          const q = index.qnameOf(want);
          if (!spelled && q) {
            // As deeply qualified as the old spelling was, when that resolves.
            const qp = q.split('::');
            if (oldSp.isGlobal) {
              if (sameResolved(index.resolve(qp, true, scope), want)) spelled = `::${q}`;
            } else if (oldSp.parts.length <= qp.length) {
              const cand = qp.slice(qp.length - oldSp.parts.length);
              if (sameResolved(index.resolve(cand, false, scope), want)) spelled = cand.join('::');
            }
          }
          if (!spelled && q) spelled = minimalSpelling(index, q, want, scope);
          if (!spelled) { errors.push(`cannot spell ${old} (${bindingKey(b)}) from ${scope.join('::') || '::'}`); return; }
        }
        break;
      }
    }
    if (spelled !== undefined && spelled !== old) {
      edits.push({ start: site.start, end: site.end, text: spelled });
      renames.push(`${old} -> ${spelled}`);
    }
    // A callee whose parameters changed: re-order the arguments by parameter identity.
    if (b.k === 'fn' && (site.call || site.called) && b.p && b.a.length === 1) {
      const nowFn = index.fnByAddr.get(b.a[0]);
      const now = nowFn?.params;
      if (now && !(now.length === b.p.length && now.every((n, k) => n === b.p![k]) && sameStorage(b.ps, nowFn.storage))) {
        const pure = site.call?.pure ?? b.p.map(() => false);
        const order = argumentOrder(paramIds(b.p, b.ps), paramIds(now, nowFn.storage), pure);
        if (typeof order === 'string') { errors.push(`call to ${old}: ${order}`); return; }
        if (order && !site.call) { errors.push(`call to ${old}: its parameters moved (${b.p.join(', ')} -> ${now.join(', ')}) but its argument list cannot be delimited`); return; }
        if (order && site.call.args.length !== b.p.length) { errors.push(`call to ${old}: ${site.call.args.length} arguments for ${b.p.length} parameters (${b.p.join(', ')} -> ${now.join(', ')})`); return; }
        if (order && site.call) {
          edits.push({ start: site.call.open, end: site.call.close, call: { args: site.call.args, order } });
          renames.push(`${old}(${b.p.join(', ')}) -> (${now.join(', ')})`);
        }
      }
    }
  });
  if (errors.length > 0 && !ctx.partial) return { errors: [...new Set(errors)], renames };
  return { text: render(text, edits, scan.bodyStart, scan.bodyEnd), errors: [...new Set(errors)], renames };
}

function sameStorage(a: string[] | undefined, b: string[] | undefined): boolean {
  return !a || !b || (a.length === b.length && a.every((x, k) => x === b[k]));
}

/**
 * New argument positions for a callee whose parameters went from `before` to `after`:
 * `order[j]` is the old argument that goes to parameter j. Undefined when nothing moves,
 * a message when it cannot be decided. Same arity: each parameter by its identity
 * (params.ts). Fewer parameters: the ones that went are found by name, and their
 * arguments are dropped only when they have no side effect.
 */
export function argumentOrder(before: ParamId[], after: ParamId[], pure: boolean[]): number[] | string | undefined {
  const bn = before.map(p => p.name);
  const an = after.map(p => p.name);
  if (bn.includes('...') || an.includes('...')) return before.length === after.length ? undefined : 'variadic parameter list changed';
  if (before.length === after.length) {
    const m = matchParams(before, after);
    if ('error' in m) return m.error;
    if (isIdentity(m.map)) return undefined;
    const order: number[] = new Array(after.length);
    m.map.forEach((j, i) => { order[j] = i; });
    return order;
  }
  const named = (l: string[]) => l.every(n => n !== '') && new Set(l).size === l.length;
  if (after.length < before.length && named(bn) && named(an) && an.every(n => bn.includes(n))) {
    const order = an.map(n => bn.indexOf(n));
    // A kept parameter whose storage is known on both sides must have kept it.
    for (let j = 0; j < after.length; j++) {
      const was = before[order[j]];
      if (was.storage && after[j].storage && was.storage !== after[j].storage && !/^Stack\[/u.test(was.storage)) {
        return `parameter ${an[j]} moved from ${was.storage} to ${after[j].storage} while parameters went`;
      }
    }
    for (let k = 0; k < before.length; k++) {
      if (!order.includes(k) && pure[k] === false) return `argument ${k} (${bn[k]}) is dropped but has a side effect`;
    }
    return order;
  }
  const gained = an.filter(n => !bn.includes(n));
  return `parameters ${bn.join(', ')} -> ${an.join(', ')}${gained.length ? ` (new: ${gained.join(', ')})` : ''}`;
}

function render(text: string, edits: Edit[], from: number, to: number): string {
  const inRange = edits.filter(e => e.start >= from && e.end <= to).sort((a, b) => a.start - b.start || b.end - a.end);
  let out = '';
  let pos = from;
  for (const e of inRange) {
    if (e.start < pos) continue; // nested in an edit already rendered
    out += text.slice(pos, e.start);
    if (e.call) {
      // Re-ordered, the arguments move and the text between them (line breaks, alignment)
      // stays where it was; with one dropped, the list is written plainly.
      const args = e.call.args;
      const parts = e.call.order.map(k => render(text, edits, args[k][0], args[k][1]));
      if (parts.length !== args.length || args.length === 0) out += `(${parts.join(', ')})`;
      else {
        const seps = args.slice(1).map((a, k) => text.slice(args[k][1], a[0]));
        out += text.slice(e.start, args[0][0]);
        parts.forEach((p, k) => { out += k > 0 ? `${seps[k - 1] ?? ', '}${p}` : p; });
        out += text.slice(args[args.length - 1][1], e.end);
      }
    } else out += e.text ?? '';
    pos = e.end;
  }
  return out + text.slice(pos, to);
}

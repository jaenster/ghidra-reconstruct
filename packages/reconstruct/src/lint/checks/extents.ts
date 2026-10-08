/**
 * Checks about OBJECT EXTENTS the emitted declaration does not carry: a scalar that the code
 * treats as a buffer, and a run of scalars that the machine treats as one object.
 *
 * All three species were found by the Zig port pilot reading the asm next to our C, and none
 * of them is caught by a size-checked write because the write goes through a derived pointer
 * or a callee, not through the declared name.
 */

import { NodeKind } from '@ghidra-mcp/cpp-parser';
import {
  calleeName, isArrayType, isPointerType, line, refName, signature, strip, typeText,
  typeWidth, unparen, walk,
} from '../ast.js';
import type { Check, Finding, LintContext, Resolved } from '../context.js';
import type { FunctionInfo } from '../tree.js';
import { renderedLength, SIZED_SINKS } from './buffers.js';

const FORMAT_SINKS = new Set(['sprintf', 'wsprintfA', 'wsprintf', 'strcpy', 'lstrcpyA', 'lstrcpy']);
const NO_LIMIT = 0x7fffffff;

/** `&x` where x is a plain scalar object (not an array, not a struct we cannot size). */
function scalarAddress(ctx: LintContext, fn: FunctionInfo, arg: any): { name: string; r: Resolved; width: number } | null {
  const s = strip(arg);
  if (s?.kind !== NodeKind.UnaryExpr || s.operator !== '&') return null;
  const op = strip(s.operand);
  const name = refName(op);
  if (!name) return null;
  const r = ctx.resolve(fn, op);
  if (!r || isArrayType(r.type)) return null;
  const width = typeWidth(r.type, ctx.sizeEnv);
  if (width === null || width < 1 || width > 8) return null;
  return { name, r, width };
}

const isStaticOrGlobal = (r: Resolved): boolean =>
  r.kind === 'global' || r.kind === 'file' || (r.kind === 'local' && r.entry.isStatic);

// -------------------------------------------------------------------------------------------
// scalar-extent-passed
// -------------------------------------------------------------------------------------------

/**
 * The address of a scalar global (or static local) handed to a call together with a byte
 * count far larger than the scalar.
 *
 * `WARDEN_ResolveAndLoadModule` passed `&gaWardenModuleLoadData` and 0x12b2 to the module
 * loader: the built-in Warden module is 4786 bytes at 0x6d74b0 and Ghidra sized the symbol at
 * one byte, so the rebuilt exe loaded one byte of it and the next 4785 were whatever the linker
 * put after the variable. The decl and the length disagree inside one call; no write is
 * visible, so oversized-global-write cannot see it. Calls the write checks already measure
 * (memcpy, memset, ReadFile ...) are left to them.
 */
export const scalarExtentPassed: Check = {
  id: 'scalar-extent-passed',
  blurb: 'address of a scalar global handed to a call with a byte count far larger than the scalar',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      for (const c of ctx.of(fn, NodeKind.CallExpr)) {
        const callee = calleeName(c.callee);
        if (callee && (SIZED_SINKS[callee] || FORMAT_SINKS.has(callee))) continue;
        const args: any[] = c.arguments;
        for (let i = 0; i < args.length; i++) {
          const a = scalarAddress(ctx, fn, args[i]);
          if (!a || !isStaticOrGlobal(a.r)) continue;
          let n: number | null = null;
          for (let j = 0; j < args.length && n === null; j++) {
            if (j === i) continue;
            const v = ctx.value(fn, args[j]);
            if (v !== null && v >= 16 && v > a.width && v <= 0x100000) n = v;
          }
          if (n === null) continue;
          const g = ctx.snapshot?.globalByName.get(a.name);
          const gap = g ? ctx.snapshot!.gapAfter.get(g.address) : null;
          // A symbol outside the image is a constant Ghidra gave a name (HWND_NOTOPMOST).
          if (g && (g.address < 0x400000 || g.address > 0x1000000)) continue;
          // A symbol that fills the whole slot up to its neighbour is the usual out-parameter
          // (`&nCount, sizeof(record)`): the binary shows no room behind it for a buffer.
          if (gap !== null && gap !== undefined && gap <= a.width) continue;
          out.push({
            check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: a.name,
            detail: `&${a.name} (${typeText(a.r.type)}, ${a.width} byte(s)) passed with 0x${n.toString(16)}` +
              `${g ? `; Ghidra symbol ${g.size} byte(s) at ${g.addressText}, ${gap ?? '?'} to the next` : ''}`,
            sig: signature(c) + `#arg${i}`,
          });
          break;
        }
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// scalar-local-cursor
// -------------------------------------------------------------------------------------------

/**
 * A scalar local used as the start of a buffer: its address is the destination of a string
 * write larger than it, or is copied into a pointer that is then walked.
 *
 * `WardenClient::LoadModule` declared `char szHexBuf;` and wrote sixteen `%02x` pairs through
 * `pszHexCursor = &szHexBuf; pszHexCursor += 2`: a 33-byte buffer Ghidra split at the next
 * stack slot, where `.mod` landed on a neighbouring local so the cache key lost its
 * extension. The frame-group pass sees only locals that a pointer into the group reaches by
 * a known offset; a cursor that advances is invisible to it. `undersized-stack-buffer` and
 * `oversized-formatted-write` measure ARRAYS, and this one is declared as a single char.
 *
 * Reports the locals declared right after the scalar - the ones the walk would land on.
 */
export const scalarLocalCursor: Check = {
  id: 'scalar-local-cursor',
  blurb: 'scalar local used as a buffer start - written past itself directly or through an advanced pointer',
  run(ctx) {
    const out: Finding[] = [];
    for (const fn of ctx.tree.functions) {
      const scope = fn.scope();
      const locals = [...scope.values()].filter(e => e.kind === 'local' && !e.isStatic);
      if (!locals.length) continue;
      const calls = ctx.of(fn, NodeKind.CallExpr);

      const neighbours = (name: string): string => {
        const i = locals.findIndex(e => e.name === name);
        return locals.slice(i + 1, i + 3).map(e => `${e.name}:${typeText(e.type)}`).join(', ');
      };
      const scalarLocal = (arg: any) => {
        const a = scalarAddress(ctx, fn, arg);
        return a && a.r.kind === 'local' && !a.r.entry.isStatic ? a : null;
      };

      // Direct: sprintf(&c, ...), SStrCopy(&c, src, 0x100).
      const need = (c: any): number | null => {
        const name = calleeName(c.callee);
        if (!name) return null;
        if (FORMAT_SINKS.has(name) && c.arguments.length >= 2) {
          const lit = strip(c.arguments[1]);
          if (lit?.kind !== NodeKind.StringLiteral) return null;
          return name.includes('printf')
            ? renderedLength(String(lit.value), c.arguments.slice(2)).need
            : String(lit.value).length + 1;
        }
        const spec = SIZED_SINKS[name];
        if (spec && c.arguments.length > spec[1]) {
          const n = ctx.value(fn, c.arguments[spec[1]]);
          return n !== null && n !== NO_LIMIT && n > 0 ? n : null;
        }
        return null;
      };
      for (const c of calls) {
        const dest = c.arguments?.[0];
        const a = dest && scalarLocal(dest);
        const n = a ? need(c) : null;
        if (!a || n === null || n <= a.width) continue;
        out.push({
          check: this.id, file: fn.file.path, line: line(c), fn: fn.qualifiedName, subject: a.name,
          detail: `${calleeName(c.callee)} writes ${n} bytes into ${typeText(a.r.type)} ${a.name} (${a.width} byte(s)); next locals: ${neighbours(a.name)}`,
          sig: signature(c),
        });
      }

      // Through a pointer seeded from &scalar and then advanced or used as a destination.
      const seeds = new Map<string, { scalar: string; width: number; type: any }>();
      for (const d of ctx.of(fn, NodeKind.VariableDecl)) {
        const nm = d.name?.name;
        const e = nm ? scope.get(nm) : null;
        if (!e || e.decl !== d || !isPointerType(d.type) || !d.initializer) continue;
        const a = scalarLocal(d.initializer);
        if (a) seeds.set(nm, { scalar: a.name, width: a.width, type: a.r.type });
      }
      for (const asg of ctx.of(fn, NodeKind.AssignExpr)) {
        if (asg.operator !== '=') continue;
        const nm = refName(unparen(asg.left));
        const e = nm ? scope.get(nm) : null;
        if (!nm || !e || e.kind !== 'local' || !isPointerType(e.type)) continue;
        const a = scalarLocal(asg.right);
        if (a) seeds.set(nm, { scalar: a.name, width: a.width, type: a.r.type });
      }
      for (const [p, seed] of seeds) {
        let site: any = null;
        let how = '';
        for (const asg of ctx.of(fn, NodeKind.AssignExpr)) {
          if ((asg.operator === '+=' || asg.operator === '-=') && refName(unparen(asg.left)) === p) { site = asg; how = `${p} ${asg.operator} ...`; break; }
        }
        if (!site) {
          for (const u of [...ctx.of(fn, NodeKind.UnaryExpr), ...ctx.of(fn, NodeKind.PostfixExpr)]) {
            if ((u.operator === '++' || u.operator === '--') && refName(unparen(u.operand)) === p) { site = u; how = `${p}${u.operator}`; break; }
          }
        }
        if (!site) {
          for (const c of calls) {
            const dest = strip(c.arguments?.[0]);
            const n = refName(dest) === p ? need(c) : null;
            if (n !== null && n > seed.width) { site = c; how = `${calleeName(c.callee)} writes ${n} bytes through ${p}`; break; }
          }
        }
        if (!site) continue;
        out.push({
          check: this.id, file: fn.file.path, line: line(site), fn: fn.qualifiedName, subject: seed.scalar,
          detail: `${p} = &${seed.scalar} (${typeText(seed.type)}, ${seed.width} byte(s)) and then ${how}; next locals: ${neighbours(seed.scalar)}`,
          sig: signature(site) + `#${p}`,
        });
      }
    }
    return out;
  },
};

// -------------------------------------------------------------------------------------------
// adjacent-scalar-run
// -------------------------------------------------------------------------------------------

/**
 * A run of separately-declared scalar globals that the code reaches as one object.
 *
 * The two Storm command lists are 12 bytes each in the binary - head, link, priority - and
 * Ghidra named them as three scalars. `StaticFini_gStormCmdListBackslash` computes
 * `(uintptr_t)&gpStormCmdListHeadBackslash - *(int*)(...)`: address arithmetic between
 * members, correct only while the linker keeps them adjacent and in order, and the node the
 * list head points back to is the head's own address.
 *
 * A run is two or more snapshot symbols that touch (address + size == next address), all
 * declared scalar. It is reported when the address of a member is used in `+`/`-` arithmetic,
 * or a member is initialised with its own address (a list head). A run that is only read and
 * written by name is the usual case and is not reported.
 */
export const adjacentScalarRun: Check = {
  id: 'adjacent-scalar-run',
  blurb: 'run of touching scalar globals whose member addresses are used in arithmetic - one object split by name',
  run(ctx) {
    const out: Finding[] = [];
    const snap = ctx.snapshot;
    if (!snap) return out;
    const scalar = (name: string): boolean => {
      const d = ctx.tree.globals.get(name);
      if (!d || isArrayType(d.type)) return false;
      const w = typeWidth(d.type, ctx.sizeEnv);
      return w !== null && w >= 1 && w <= 8;
    };
    // name -> run index
    const runOf = new Map<string, number>();
    const runs: string[][] = [];
    let cur: typeof snap.globals = [];
    const flush = () => {
      if (cur.length >= 2) {
        const names = cur.map(g => g.name);
        names.forEach(n => runOf.set(n, runs.length));
        runs.push(names);
      }
      cur = [];
    };
    for (const g of snap.globals) {
      if (!g.size || !scalar(g.name)) { flush(); continue; }
      const last = cur[cur.length - 1];
      if (last && last.address + last.size !== g.address) flush();
      cur.push(g);
    }
    flush();
    if (!runs.length) return out;

    const evidence = new Map<number, Array<{ file: string; line: number; fn?: string; what: string; sig: string }>>();
    const note = (member: string, e: { file: string; line: number; fn?: string; what: string; sig: string }) => {
      const k = runOf.get(member);
      if (k === undefined) return;
      let l = evidence.get(k);
      if (!l) evidence.set(k, (l = []));
      l.push(e);
    };
    const addrOfMember = (fn: FunctionInfo | null, file: any, e: any): string | null => {
      const s = strip(e);
      if (s?.kind !== NodeKind.UnaryExpr || s.operator !== '&') return null;
      const op = strip(s.operand);
      const nm = refName(op);
      if (!nm || !runOf.has(nm)) return null;
      const r = ctx.resolve(fn, op, file);
      return r && r.kind === 'global' ? nm : null;
    };
    for (const fn of ctx.tree.functions) {
      for (const b of ctx.of(fn, NodeKind.BinaryExpr)) {
        if (b.operator !== '+' && b.operator !== '-') continue;
        for (const side of [b.left, b.right]) {
          const m = addrOfMember(fn, fn.file, side);
          if (m) note(m, { file: fn.file.path, line: line(b), fn: fn.qualifiedName, what: `&${m} in ${b.operator}`, sig: signature(b) });
        }
      }
    }
    for (const file of ctx.tree.files) {
      if (file.isHeader) continue;
      for (const d of ctx.fileScope(file).values()) {
        const nm = d.name?.name;
        if (!nm || !runOf.has(nm) || !d.initializer) continue;
        walk(d.initializer, (n: any) => {
          if (n.kind === NodeKind.UnaryExpr && n.operator === '&' && refName(strip(n.operand)) === nm) {
            note(nm, { file: file.path, line: line(d), what: `${nm} initialised with its own address`, sig: signature(d) });
          }
        });
      }
    }
    for (const [k, ev] of evidence) {
      const names = runs[k];
      out.push({
        check: this.id, file: ev[0].file, line: ev[0].line, fn: ev[0].fn, subject: names[0],
        detail: `${names.length} touching scalar globals [${names.join(', ')}]: ${ev.length} address use(s), e.g. ${ev[0].what}`,
        sig: `run:${names.join(',')}`,
      });
    }
    return out;
  },
};

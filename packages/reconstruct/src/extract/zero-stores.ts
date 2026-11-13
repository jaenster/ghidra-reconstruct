/**
 * Which bytes of each struct-typed stack local the original's first stores to it write, and
 * which of those it writes with zero, read from the instructions.
 *
 * `T s = {0};` compiles to a zero store per member; the decompiler prints those stores and
 * drops the ones a later assignment overwrites, so a decompile cannot tell `T s = {0};` from
 * members cleared one by one. The instructions keep every zero store the compiler emitted.
 * The decompiler drops a zero store a later store overwrites, so a decompile that prints no
 * zero store at all can still have one in the original; the fact is read wherever the
 * decompile stores to a member of a local (`printsMemberStore`).
 * The `aggregate-zero-init` pass only writes the initialiser where this fact shows the
 * original zeroing every member byte:
 *
 *   name    the decompiler's name for the local
 *   offset  its stack offset (the frame offsets Ghidra's stack references use), size its size
 *   zero    the bytes, relative to the local, the opening run stores zero to
 *   other   the bytes the opening run stores anything else to
 *
 * The opening run is every store to the local, in address order, up to the first instruction
 * that reads it, takes its address for anything but a zeroing fill, or writes it in place
 * (`add [s], 1`). A byte keeps what its first store wrote. Zero is:
 *
 *   - a store of the constant 0, or of a register the same block set to 0 (`xor eax, eax`,
 *     `sub eax, eax`, `mov eax, 0`, or a copy of such a register) with nothing writing it
 *     since; a sub-register store reads its part of that value (AH: bits 8-15);
 *   - `rep stos` with EDI a `lea` of the local and ECX and EAX (AX, AL) known from the block:
 *     ECX units of zero from there;
 *   - a call of `memset` whose pushed arguments in the block are a `lea` of the local, 0 and
 *     a constant size.
 *
 * The script only prints what each instruction is (`ZERO_STORES_JAVA`); the walk above runs
 * here (`zeroStoresFromTrace`), where it can be tested on the instructions of known functions.
 *
 * Read-only: part of the per-function facts script (function-facts.ts), no transaction. A
 * failure leaves the field unset; the pass then changes nothing, since it needs this fact.
 */

export interface ZeroStoreLocal {
  name: string;
  offset: number;
  size: number;
  /** [from, to) byte ranges relative to the local, ascending and disjoint. */
  zero: [number, number][];
  other: [number, number][];
}

export type ZeroStoreFacts = ZeroStoreLocal[];

/** An instruction operand as the trace prints it. */
export type TraceOperand = { reg: string } | { imm: number } | { mem: true } | null;

/** One instruction of the function, in address order. */
export interface TraceInsn {
  /** Offset from the function entry. */
  at: number;
  /** A flow reference lands on it: what the block knew no longer holds. */
  entered: boolean;
  call: boolean;
  mnemonic: string;
  op0: TraceOperand;
  op1: TraceOperand;
  /** The registers it writes, flags left out. */
  writes: string[];
  /** Ghidra's stack references from it: frame offset and r(ead), w(rite), x (both), a(ddress). */
  refs: { offset: number; kind: 'r' | 'w' | 'x' | 'a' }[];
  /** The displacement of an `[EBP + disp]` operand; null for any other. */
  ebpDisp: number | null;
  /** What a STORE writes: its size and the constant or register the value is a copy of. */
  store: { size: number; value: { imm: number } | { reg: string } | null } | null;
  /** The callee's name, through a thunk; null when unknown or not a call. */
  target: string | null;
}

export interface ZeroStoreTrace {
  locals: { name: string; offset: number; size: number }[];
  /** `push ebp; mov ebp, esp` opens the function: [EBP + d] is frame offset d - 4. */
  ebpFrame: boolean;
  insns: TraceInsn[];
}

/**
 * Java fragment, run per function inside the facts script with `r` (the decompile results),
 * `fn`, `fm`, `L` (the listing), `rm` (the reference manager), `prog` and `base` in scope.
 * Leaves the row in `zrow`, empty when the function has no struct-typed stack local:
 *
 *   locals TAB ebpFrame TAB trace
 *   locals  `name,offset,size;...`
 *   trace   `;`-separated instructions `at,flags,mnemonic,op0,op1,writes,refs,ebpDisp,store,target`:
 *           flags `e` (entered) `c` (call); an operand `r:REG`, `i:hex`, `m` or `-`; writes and
 *           refs `|`-separated, a ref `offset:kind`; store `size:c:hex`, `size:r:REG` or
 *           `size:?`. Offsets are signed hex (`-1c`); `-` stands for none.
 */
export const ZERO_STORES_JAVA = `
          StringBuilder zrow = new StringBuilder();
          try {
            ghidra.program.model.pcode.HighFunction zh = r.getHighFunction();
            StringBuilder zloc = new StringBuilder();
            if (zh != null) {
              java.util.Iterator<ghidra.program.model.pcode.HighSymbol> zit = zh.getLocalSymbolMap().getSymbols();
              while (zit.hasNext()) {
                ghidra.program.model.pcode.HighSymbol zs = zit.next();
                if (zs.isParameter()) continue;
                ghidra.program.model.listing.VariableStorage zst = zs.getStorage();
                if (zst == null || !zst.isStackStorage()) continue;
                ghidra.program.model.data.DataType zdt = zs.getDataType();
                for (int d = 0; d < 8 && zdt instanceof ghidra.program.model.data.TypeDef; d++) zdt = ((ghidra.program.model.data.TypeDef) zdt).getBaseDataType();
                if (!(zdt instanceof ghidra.program.model.data.Structure) && !(zdt instanceof ghidra.program.model.data.Union)) continue;
                int zsz = zs.getSize();
                if (zsz < 2 || zsz > 0x10000 || !zs.getName().matches("[A-Za-z_][A-Za-z0-9_]*")) continue;
                int zo = (int) zst.getStackOffset();
                zloc.append(zloc.length() > 0 ? ";" : "").append(zs.getName()).append(',')
                  .append(zo < 0 ? "-" + Integer.toHexString(-zo) : Integer.toHexString(zo)).append(',').append(Integer.toHexString(zsz));
              }
            }
            if (zloc.length() > 0) {
              ghidra.program.model.listing.Instruction z0 = L.getInstructionAt(fn.getEntryPoint());
              ghidra.program.model.listing.Instruction z1 = z0 == null ? null : z0.getNext();
              boolean zFrame = z0 != null && z1 != null && z0.toString().equals("PUSH EBP") && z1.toString().equals("MOV EBP,ESP");
              StringBuilder ztr = new StringBuilder();
              ghidra.program.model.listing.InstructionIterator zi = L.getInstructions(fn.getBody(), true);
              while (zi.hasNext()) {
                ghidra.program.model.listing.Instruction ins = zi.next();
                StringBuilder it = new StringBuilder();
                it.append(Long.toHexString(ins.getAddress().getOffset() - base)).append(',');
                boolean entered = false;
                for (ghidra.program.model.symbol.Reference rf : rm.getReferencesTo(ins.getAddress())) if (rf.getReferenceType().isFlow()) entered = true;
                boolean zcall = ins.getFlowType().isCall();
                it.append(entered ? "e" : "").append(zcall ? "c" : "").append(entered || zcall ? "" : "-").append(',');
                it.append(ins.getMnemonicString()).append(',');
                for (int oi = 0; oi < 2; oi++) {
                  String od = "-";
                  if (oi < ins.getNumOperands()) {
                    int ot = ins.getOperandType(oi);
                    if (ghidra.program.model.lang.OperandType.isRegister(ot) && ins.getRegister(oi) != null) od = "r:" + ins.getRegister(oi).getName();
                    else if (ghidra.program.model.lang.OperandType.isScalar(ot) && ins.getScalar(oi) != null) od = "i:" + Long.toHexString(ins.getScalar(oi).getUnsignedValue() & 0xffffffffL);
                    else od = "m";
                  }
                  it.append(od).append(',');
                }
                StringBuilder zw = new StringBuilder();
                for (Object ro : ins.getResultObjects()) {
                  if (!(ro instanceof ghidra.program.model.lang.Register)) continue;
                  ghidra.program.model.lang.Register g = (ghidra.program.model.lang.Register) ro;
                  if (g.getBitLength() < 8) continue;
                  zw.append(zw.length() > 0 ? "|" : "").append(g.getName());
                }
                it.append(zw.length() > 0 ? zw : "-").append(',');
                StringBuilder zr = new StringBuilder();
                for (ghidra.program.model.symbol.Reference rf : rm.getReferencesFrom(ins.getAddress())) {
                  if (!(rf instanceof ghidra.program.model.symbol.StackReference)) continue;
                  int so = (int) ((ghidra.program.model.symbol.StackReference) rf).getStackOffset();
                  ghidra.program.model.symbol.RefType rt = rf.getReferenceType();
                  String k = rt.isRead() && rt.isWrite() ? "x" : rt.isWrite() ? "w" : rt.isRead() ? "r" : "a";
                  zr.append(zr.length() > 0 ? "|" : "").append(so < 0 ? "-" + Integer.toHexString(-so) : Integer.toHexString(so)).append(':').append(k);
                }
                it.append(zr.length() > 0 ? zr : "-").append(',');
                String zd = "-";
                for (int oi = 0; oi < ins.getNumOperands(); oi++) {
                  Object[] ob = ins.getOpObjects(oi);
                  if (ob.length == 2 && ob[0] instanceof ghidra.program.model.lang.Register && ((ghidra.program.model.lang.Register) ob[0]).getName().equals("EBP")
                      && ob[1] instanceof ghidra.program.model.scalar.Scalar && !ghidra.program.model.lang.OperandType.isRegister(ins.getOperandType(oi))) {
                    int dv = (int) ((ghidra.program.model.scalar.Scalar) ob[1]).getValue();
                    zd = dv < 0 ? "-" + Integer.toHexString(-dv) : Integer.toHexString(dv);
                  }
                }
                it.append(zd).append(',');
                String zsv = "-";
                ghidra.program.model.pcode.PcodeOp[] zops = ins.getPcode();
                for (ghidra.program.model.pcode.PcodeOp po : zops) {
                  if (po.getOpcode() != ghidra.program.model.pcode.PcodeOp.STORE) continue;
                  ghidra.program.model.pcode.Varnode v = po.getInput(2);
                  // The value is a copy of an operand: follow the COPYs this instruction made.
                  for (int h = 0; h < 4 && v != null && v.isUnique(); h++) {
                    ghidra.program.model.pcode.Varnode src = null;
                    for (ghidra.program.model.pcode.PcodeOp q : zops) {
                      if (q.getOutput() != null && q.getOutput().equals(v) && q.getOpcode() == ghidra.program.model.pcode.PcodeOp.COPY) src = q.getInput(0);
                    }
                    v = src;
                  }
                  int vs = po.getInput(2).getSize();
                  if (v != null && v.isConstant()) zsv = vs + ":c:" + Long.toHexString(v.getOffset());
                  else if (v != null && v.isRegister() && prog.getRegister(v.getAddress(), v.getSize()) != null) zsv = vs + ":r:" + prog.getRegister(v.getAddress(), v.getSize()).getName();
                  else zsv = vs + ":?";
                }
                it.append(zsv).append(',');
                String zt = "-";
                if (zcall && ins.getFlows().length == 1) {
                  ghidra.program.model.listing.Function tf = fm.getFunctionAt(ins.getFlows()[0]);
                  if (tf != null && tf.isThunk()) tf = tf.getThunkedFunction(true);
                  if (tf != null && tf.getName().matches("[A-Za-z_][A-Za-z0-9_]*")) zt = tf.getName();
                }
                it.append(zt);
                ztr.append(ztr.length() > 0 ? ";" : "").append(it);
              }
              zrow.append(zloc).append('\\t').append(zFrame ? 1 : 0).append('\\t').append(ztr);
            }
          } catch (Exception ze) { zrow.setLength(0); }
`;

/**
 * A store to a member of a local: the decompiles whose struct locals are read. Any value, not
 * only zero: where every member is stored after the opening zero stores, the decompiler drops
 * them all as dead and prints no zero store at all (NET_D2GS_SERVER_Send_0xA5_FORCESTOPSKILL
 * 0053c190: `xor eax, eax` and two dword stores clear the packet, then each member is stored).
 */
const MEMBER_STORE = /[A-Za-z_]\w*\.[A-Za-z_][\w.]*(?:\[[^\]\n]*\])*\s*=(?!=)/;

export function printsMemberStore(decompiled: string): boolean {
  return MEMBER_STORE.test(decompiled);
}

const signedHex = (s: string): number | null => {
  const m = /^(-?)([0-9a-f]+)$/i.exec(s);
  if (!m) return null;
  const v = Number.parseInt(m[2], 16);
  return (m[1] ? -v : v) | 0;
};

function operand(s: string): TraceOperand | undefined {
  if (s === '-') return null;
  if (s === 'm') return { mem: true };
  if (s.startsWith('r:')) return { reg: s.slice(2) };
  if (s.startsWith('i:') && /^[0-9a-f]+$/i.test(s.slice(2))) return { imm: Number.parseInt(s.slice(2), 16) >>> 0 };
  return undefined;
}

/** The script's row (without the entry), parsed into a trace; null when malformed. */
export function parseZeroStoreTrace(row: string): ZeroStoreTrace | null {
  const [loc, frame, trace] = row.split('\t');
  if (loc === undefined || frame === undefined || trace === undefined) return null;
  const locals: ZeroStoreTrace['locals'] = [];
  for (const item of loc.split(';')) {
    const c = item.split(',');
    const off = c.length === 3 ? signedHex(c[1]) : null;
    if (off === null || !/^[A-Za-z_]\w*$/.test(c[0]) || !/^[0-9a-f]+$/i.test(c[2])) return null;
    locals.push({ name: c[0], offset: off, size: Number.parseInt(c[2], 16) });
  }
  const insns: TraceInsn[] = [];
  for (const item of trace ? trace.split(';') : []) {
    const c = item.split(',');
    if (c.length !== 10 || !/^[0-9a-f]+$/i.test(c[0])) return null;
    const op0 = operand(c[3]), op1 = operand(c[4]);
    if (op0 === undefined || op1 === undefined) return null;
    const refs: TraceInsn['refs'] = [];
    for (const r of c[6] === '-' ? [] : c[6].split('|')) {
      const [o, k] = r.split(':');
      const off = signedHex(o ?? '');
      if (off === null || !['r', 'w', 'x', 'a'].includes(k ?? '')) return null;
      refs.push({ offset: off, kind: k as 'r' | 'w' | 'x' | 'a' });
    }
    let store: TraceInsn['store'] = null;
    if (c[8] !== '-') {
      const m = /^(\d+):(?:c:([0-9a-f]+)|r:(\w+)|\?)$/i.exec(c[8]);
      if (!m) return null;
      store = { size: Number(m[1]), value: m[2] !== undefined ? { imm: Number.parseInt(m[2], 16) } : m[3] !== undefined ? { reg: m[3] } : null };
    }
    insns.push({
      at: Number.parseInt(c[0], 16),
      entered: c[1].includes('e'),
      call: c[1].includes('c'),
      mnemonic: c[2],
      op0, op1,
      writes: c[5] === '-' ? [] : c[5].split('|'),
      refs,
      ebpDisp: c[7] === '-' ? null : signedHex(c[7]),
      store,
      target: c[9] === '-' ? null : c[9],
    });
  }
  return { locals, ebpFrame: frame === '1', insns };
}

/** x86 register -> the 32-bit register it is part of, and where its bytes sit. */
const PARTS: Record<string, { base: string; shift: number; bytes: number }> = {};
for (const r of ['A', 'B', 'C', 'D']) {
  PARTS[`E${r}X`] = { base: `E${r}X`, shift: 0, bytes: 4 };
  PARTS[`${r}X`] = { base: `E${r}X`, shift: 0, bytes: 2 };
  PARTS[`${r}L`] = { base: `E${r}X`, shift: 0, bytes: 1 };
  PARTS[`${r}H`] = { base: `E${r}X`, shift: 8, bytes: 1 };
}
for (const r of ['SI', 'DI', 'BP', 'SP']) {
  PARTS[`E${r}`] = { base: `E${r}`, shift: 0, bytes: 4 };
  PARTS[r] = { base: `E${r}`, shift: 0, bytes: 2 };
}

const MEMSET = new Set(['memset', '_memset']);

type Value = { imm: number } | { lea: { at: number; offset: number } } | null;

/** What the opening stores of each local write, from the function's trace. */
export function zeroStoresFromTrace(trace: ZeroStoreTrace): ZeroStoreFacts {
  const { locals, insns } = trace;
  // [EBP + d] is frame offset d - 4 where the function opens with push ebp; mov ebp, esp.
  const refsOf = (i: TraceInsn): TraceInsn['refs'] => {
    if (i.refs.length > 0 || !trace.ebpFrame || i.ebpDisp === null) return i.refs;
    const kind = i.mnemonic === 'LEA' ? 'a' : i.store && i.mnemonic === 'MOV' ? 'w' : 'r';
    return [{ offset: i.ebpDisp - 4, kind }];
  };

  /** Walk the trace with what each block knows of its registers; `visit` sees the state before each instruction. */
  const walk = (visit: (i: TraceInsn, imm: ReadonlyMap<string, number>, lea: ReadonlyMap<string, { at: number; offset: number }>, pushed: readonly Value[]) => void) => {
    const imm = new Map<string, number>();
    const lea = new Map<string, { at: number; offset: number }>();
    let pushed: Value[] = [];
    const valueOf = (o: TraceOperand): Value => {
      if (!o) return null;
      if ('imm' in o) return { imm: o.imm };
      if ('reg' in o) {
        const p = PARTS[o.reg];
        if (!p || p.bytes !== 4) return null;
        if (imm.has(p.base)) return { imm: imm.get(p.base)! };
        if (lea.has(p.base)) return { lea: lea.get(p.base)! };
      }
      return null;
    };
    for (const i of insns) {
      if (i.entered) { imm.clear(); lea.clear(); pushed = []; }
      visit(i, imm, lea, pushed);
      if (i.call) { imm.clear(); lea.clear(); pushed = []; continue; }
      if (i.mnemonic === 'PUSH') pushed.push(valueOf(i.op0));
      const before = valueOf(i.op1);
      for (const w of i.writes) {
        const b = PARTS[w]?.base ?? w;
        imm.delete(b);
        lea.delete(b);
      }
      const d = i.op0 && 'reg' in i.op0 ? PARTS[i.op0.reg] : undefined;
      if (!d || d.bytes !== 4) continue;
      const same = !!i.op1 && 'reg' in i.op1 && i.op1.reg === (i.op0 as { reg: string }).reg;
      if (i.mnemonic === 'MOV' && before) {
        if ('imm' in before) imm.set(d.base, before.imm >>> 0);
        else lea.set(d.base, before.lea);
      } else if ((i.mnemonic === 'XOR' || i.mnemonic === 'SUB') && same) imm.set(d.base, 0);
      else if (i.mnemonic === 'OR' && before && 'imm' in before && before.imm >>> 0 === 0xffffffff) imm.set(d.base, 0xffffffff);
      else if (i.mnemonic === 'LEA') {
        const r = refsOf(i);
        if (r.length === 1) lea.set(d.base, { at: i.at, offset: r[0].offset });
      }
    }
  };

  // The zeroing fills, and the LEAs that only feed them.
  const fills = new Map<number, { offset: number; length: number }>();
  const feeds = new Set<number>();
  walk((i, imm, lea, pushed) => {
    if (i.mnemonic.startsWith('STOS') && i.mnemonic.includes('.REP')) {
      const unit = i.mnemonic.startsWith('STOSD') ? 4 : i.mnemonic.startsWith('STOSW') ? 2 : 1;
      const dst = lea.get('EDI'), n = imm.get('ECX'), v = imm.get('EAX');
      const mask = unit === 4 ? 0xffffffff : unit === 2 ? 0xffff : 0xff;
      if (dst && n !== undefined && v !== undefined && ((v & mask) >>> 0) === 0) {
        fills.set(i.at, { offset: dst.offset, length: n * unit });
        feeds.add(dst.at);
      }
    } else if (i.call && i.target && MEMSET.has(i.target) && pushed.length >= 3) {
      const [size, value, dst] = pushed.slice(-3);
      if (dst && 'lea' in dst && value && 'imm' in value && value.imm === 0 && size && 'imm' in size) {
        fills.set(i.at, { offset: dst.lea.offset, length: size.imm });
        feeds.add(dst.lea.at);
      }
    }
  });

  const zero = locals.map(() => new Set<number>());
  const other = locals.map(() => new Set<number>());
  const open = locals.map(() => true);
  const mark = (k: number, from: number, to: number, isZero: (byte: number) => boolean) => {
    const l = locals[k];
    for (let b = Math.max(from, l.offset); b < Math.min(to, l.offset + l.size); b++) {
      const rb = b - l.offset;
      if (zero[k].has(rb) || other[k].has(rb)) continue;
      (isZero(b - from) ? zero[k] : other[k]).add(rb);
    }
  };
  walk((i, imm) => {
    const fill = fills.get(i.at);
    if (fill) {
      locals.forEach((_, k) => { if (open[k]) mark(k, fill.offset, fill.offset + fill.length, () => true); });
      return;
    }
    if (feeds.has(i.at)) return;
    // The stored value, byte by byte: a constant, or a register the block knows.
    let value: number | undefined;
    const v = i.store?.value;
    if (v && 'imm' in v) value = v.imm;
    else if (v && 'reg' in v) {
      const p = PARTS[v.reg];
      const known = p ? imm.get(p.base) : undefined;
      if (p && known !== undefined) value = Math.floor(known / 2 ** p.shift);
    }
    for (const ref of refsOf(i)) {
      locals.forEach((l, k) => {
        if (!open[k]) return;
        const store = !!i.store && ref.kind === 'w';
        const end = store ? ref.offset + i.store!.size : ref.offset + 1;
        if (end <= l.offset || ref.offset >= l.offset + l.size) return;
        if (!store) { open[k] = false; return; }
        // A store writes a value, not bytes: `cb = 0x44` is no zero store, whatever its upper bytes hold.
        const zeroValue = value !== undefined && value % 2 ** (8 * i.store!.size) === 0;
        mark(k, ref.offset, end, () => zeroValue);
      });
    }
  });

  const ranges = (s: Set<number>): [number, number][] => {
    const out: [number, number][] = [];
    for (const b of [...s].sort((x, y) => x - y)) {
      const last = out[out.length - 1];
      if (last && last[1] === b) last[1] = b + 1;
      else out.push([b, b + 1]);
    }
    return out;
  };
  return locals.map((l, k) => ({ ...l, zero: ranges(zero[k]), other: ranges(other[k]) }));
}

/** One function's row, as the facts script prints it without the entry. */
export function parseZeroStoreRow(row: string): ZeroStoreFacts {
  const t = parseZeroStoreTrace(row);
  return t ? zeroStoresFromTrace(t) : [];
}

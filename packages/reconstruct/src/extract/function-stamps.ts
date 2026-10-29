/**
 * What a function's decompile depends on, hashed inside Ghidra so a cache can tell a stale
 * fact from a current one without decompiling again.
 *
 * Three stamps, all computed by the same Java (`STAMPER_JAVA`, a local class the scripts
 * declare inside GhidraScript.run()):
 *
 *   program  everything that changes every decompile at once: the Ghidra version, the
 *            language and compiler spec, the calling conventions the spec offers (a model
 *            installed as a spec extension included), the memory map with permissions, and
 *            the data organization. A change here drops every cached entry.
 *
 *   self     the function as the listing holds it: its own prototype, convention, flags,
 *            call fixup, purge and storage; its frame and every variable (name, storage,
 *            first use, type); the body's address set and bytes; per code unit the five
 *            comment kinds, every symbol (override labels included), the equates, flow and
 *            fallthrough overrides, the defined data in the body; the context-register
 *            values over the body; and every reference out of the body, each target stamped
 *            in turn: its symbols with their namespaces, the callee's whole prototype when
 *            a function sits there (through a thunk too), the data there with its type,
 *            mutability and bytes. A scalar operand that is an address in the image is
 *            stamped as a target too, since the decompiler resolves it without a reference.
 *
 *   type     per data type the decompile's markup names (a type token, a variable's type,
 *            a field token's parent, the prototype's types, and through each pointer,
 *            typedef and array to what it reaches): `full` and `shape`.
 *              shape  the layout with every name left out: size, alignment, packing, and per
 *                     component its offset, size and the component type's shape. A pointer
 *                     contributes its size and the pointee's id only, so a struct reached
 *                     through a pointer does not move its holders.
 *              full   the shape plus the names: the type's path and every field name. A
 *                     component held by value contributes its shape, not its full stamp, so
 *                     renaming an embedded struct moves only the users that print it.
 *            A field-type change moves the struct's shape, the shape of every struct that
 *            embeds it by value (the closure is the recursion), and so their full stamps.
 *
 * Types are keyed by the program DataTypeManager's id, which survives a rename. A type that
 * was deleted stamps as `gone`, so its dependents miss.
 */

/**
 * Java, no imports; declares `S` (the stamper) and `prog`. Thread-safe: the memo tables are
 * concurrent and each hash builds its own digest.
 */
export const STAMPER_JAVA = `
final ghidra.program.model.listing.Program prog = currentProgram;
final ghidra.program.model.data.DataTypeManager dtm = prog.getDataTypeManager();
final ghidra.program.model.listing.Listing LS = prog.getListing();
final ghidra.program.model.symbol.SymbolTable STB = prog.getSymbolTable();
final ghidra.program.model.symbol.ReferenceManager RMS = prog.getReferenceManager();
final ghidra.program.model.listing.FunctionManager FMS = prog.getFunctionManager();
final ghidra.program.model.mem.Memory MEM = prog.getMemory();
final ghidra.program.model.symbol.EquateTable EQT = prog.getEquateTable();
final ghidra.program.model.listing.ProgramContext PCX = prog.getProgramContext();
class H {
  final java.security.MessageDigest md;
  H() { try { md = java.security.MessageDigest.getInstance("SHA-1"); } catch (Exception e) { throw new RuntimeException(e); } }
  H s(Object o) { md.update(String.valueOf(o).getBytes(java.nio.charset.StandardCharsets.UTF_8)); md.update((byte) 0); return this; }
  H b(byte[] x) { md.update(x); md.update((byte) 1); return this; }
  String done() { byte[] d = md.digest(); StringBuilder o = new StringBuilder(); for (int i = 0; i < 8; i++) o.append(String.format("%02x", d[i] & 0xff)); return o.toString(); }
}
class Stamper {
  final java.util.concurrent.ConcurrentHashMap<Long, String[]> typeMemo = new java.util.concurrent.ConcurrentHashMap<>();
  final java.util.concurrent.ConcurrentHashMap<ghidra.program.model.address.Address, String> atMemo = new java.util.concurrent.ConcurrentHashMap<>();
  long id(ghidra.program.model.data.DataType dt) { return dt == null ? -1 : dtm.getID(dt); }
  /** [full, shape] of a type. */
  String[] type(ghidra.program.model.data.DataType dt) { return type(dt, 0); }
  String[] type(ghidra.program.model.data.DataType dt, int depth) {
    if (dt == null) return new String[] { "null", "null" };
    if (depth > 48) return new String[] { "deep", "deep" };
    long k = id(dt);
    if (k >= 0) { String[] m = typeMemo.get(k); if (m != null) return m; }
    H f = new H(), s = new H();
    f.s(dt.getClass().getSimpleName()).s(dt.getPathName()).s(dt.getLength());
    s.s(dt.getClass().getSimpleName()).s(dt.getLength());
    if (dt instanceof ghidra.program.model.data.Pointer) {
      ghidra.program.model.data.DataType to = ((ghidra.program.model.data.Pointer) dt).getDataType();
      String p = to == null ? "void" : "#" + id(to) + (id(to) < 0 ? to.getPathName() : "");
      f.s(p); s.s(p);
    } else if (dt instanceof ghidra.program.model.data.TypeDef) {
      ghidra.program.model.data.TypeDef td = (ghidra.program.model.data.TypeDef) dt;
      String[] b = type(td.getDataType(), depth + 1);
      f.s(b[0]); s.s(b[1]);
      ghidra.docking.settings.Settings st = td.getDefaultSettings();
      if (st != null) for (String n : st.getNames()) { f.s(n).s(st.getValue(n)); s.s(n).s(st.getValue(n)); }
    } else if (dt instanceof ghidra.program.model.data.Array) {
      ghidra.program.model.data.Array a = (ghidra.program.model.data.Array) dt;
      String[] e = type(a.getDataType(), depth + 1);
      f.s(a.getNumElements()).s(a.getElementLength()).s(e[0]);
      s.s(a.getNumElements()).s(a.getElementLength()).s(e[1]);
    } else if (dt instanceof ghidra.program.model.data.BitFieldDataType) {
      ghidra.program.model.data.BitFieldDataType bf = (ghidra.program.model.data.BitFieldDataType) dt;
      String[] e = type(bf.getBaseDataType(), depth + 1);
      f.s(bf.getBitOffset()).s(bf.getBitSize()).s(e[0]);
      s.s(bf.getBitOffset()).s(bf.getBitSize()).s(e[1]);
    } else if (dt instanceof ghidra.program.model.data.Composite) {
      ghidra.program.model.data.Composite c = (ghidra.program.model.data.Composite) dt;
      f.s(c.getAlignment()).s(c.isPackingEnabled()).s(c.isNotYetDefined());
      s.s(c.getAlignment()).s(c.isPackingEnabled()).s(c.isNotYetDefined());
      for (ghidra.program.model.data.DataTypeComponent dc : c.getDefinedComponents()) {
        String[] e = type(dc.getDataType(), depth + 1);
        f.s(dc.getOffset()).s(dc.getLength()).s(dc.getFieldName()).s(e[1]);
        s.s(dc.getOffset()).s(dc.getLength()).s(e[1]);
      }
    } else if (dt instanceof ghidra.program.model.data.Enum) {
      ghidra.program.model.data.Enum en = (ghidra.program.model.data.Enum) dt;
      java.util.TreeMap<String, Long> vals = new java.util.TreeMap<>();
      for (String n : en.getNames()) vals.put(n, en.getValue(n));
      java.util.TreeSet<Long> vs = new java.util.TreeSet<>(vals.values());
      for (java.util.Map.Entry<String, Long> e : vals.entrySet()) f.s(e.getKey()).s(e.getValue());
      for (Long v : vs) s.s(v);
    } else if (dt instanceof ghidra.program.model.data.FunctionDefinition) {
      ghidra.program.model.data.FunctionDefinition fd = (ghidra.program.model.data.FunctionDefinition) dt;
      f.s(fd.getPrototypeString(true));
      String sh = fd.getCallingConventionName() + "|" + fd.hasVarArgs() + "|" + fd.hasNoReturn() + "|" + type(fd.getReturnType(), depth + 1)[1];
      f.s(sh); s.s(sh);
      for (ghidra.program.model.data.ParameterDefinition pd : fd.getArguments()) { String[] e = type(pd.getDataType(), depth + 1); f.s(e[1]); s.s(e[1]); }
    }
    String[] out = new String[] { f.done(), s.done() };
    if (k >= 0) typeMemo.put(k, out);
    return out;
  }
  /** Stamp of a type by id; \`gone\` when the manager no longer has it. */
  String[] typeById(long k) {
    ghidra.program.model.data.DataType dt = dtm.getDataType(k);
    return dt == null ? new String[] { "gone", "gone" } : type(dt);
  }
  /** Add a type and what it reaches through pointers, typedefs, arrays and bit fields. */
  void deps(ghidra.program.model.data.DataType dt, java.util.Set<Long> out) {
    for (int g = 0; dt != null && g < 16; g++) {
      long k = id(dt);
      if (k >= 0) out.add(k);
      if (dt instanceof ghidra.program.model.data.Pointer) dt = ((ghidra.program.model.data.Pointer) dt).getDataType();
      else if (dt instanceof ghidra.program.model.data.TypeDef) dt = ((ghidra.program.model.data.TypeDef) dt).getDataType();
      else if (dt instanceof ghidra.program.model.data.Array) dt = ((ghidra.program.model.data.Array) dt).getDataType();
      else if (dt instanceof ghidra.program.model.data.BitFieldDataType) dt = ((ghidra.program.model.data.BitFieldDataType) dt).getBaseDataType();
      else break;
    }
  }
  /** A function as its callers see it: name, prototype, convention, flags, storage, types. */
  String callee(ghidra.program.model.listing.Function g) {
    H h = new H();
    h.s(g.getName(true)).s(g.getEntryPoint()).s(g.getCallingConventionName()).s(g.getPrototypeString(true, true))
      .s(g.getSignatureSource()).s(g.hasVarArgs()).s(g.isInline()).s(g.hasNoReturn()).s(g.hasCustomVariableStorage())
      .s(g.getCallFixup()).s(g.getStackPurgeSize()).s(g.isThunk()).s(g.isExternal());
    ghidra.program.model.listing.Parameter r = g.getReturn();
    if (r != null) h.s(r.getVariableStorage()).s(type(r.getDataType())[0]);
    for (ghidra.program.model.listing.Parameter p : g.getParameters()) h.s(p.getName()).s(p.getVariableStorage()).s(type(p.getDataType())[0]);
    if (g.isThunk()) { ghidra.program.model.listing.Function t = g.getThunkedFunction(true); if (t != null && t != g) h.s(callee(t)); }
    return h.done();
  }
  /** What sits at an address another function's code names. */
  String at(ghidra.program.model.address.Address a) {
    String m = atMemo.get(a);
    if (m != null) return m;
    H h = new H();
    h.s(a);
    for (ghidra.program.model.symbol.Symbol s : STB.getSymbols(a)) h.s(s.getName(true)).s(s.getSymbolType()).s(s.isPrimary()).s(s.getSource());
    ghidra.program.model.listing.Function g = FMS.getFunctionAt(a);
    if (g != null) h.s(callee(g));
    if (a.isMemoryAddress()) {
      ghidra.program.model.listing.Data d = LS.getDataContaining(a);
      if (d != null) {
        h.s(d.getMinAddress()).s(type(d.getDataType())[0]);
        try { h.s(ghidra.program.model.data.MutabilitySettingsDefinition.DEF.getChoice(d)); } catch (Exception e) { h.s("m?"); }
        int n = (int) Math.min(d.getLength(), 1024);
        if (n > 0) { byte[] by = new byte[n]; try { MEM.getBytes(d.getMinAddress(), by); h.b(by); } catch (Exception e) { h.s("nb"); } }
      }
    }
    String out = h.done();
    atMemo.put(a, out);
    return out;
  }
  /** The function as the listing holds it, and every target its code names. */
  String fn(ghidra.program.model.listing.Function f) {
    H h = new H();
    ghidra.program.model.address.AddressSetView body = f.getBody();
    h.s(callee(f)).s(body).s(f.getComment()).s(f.getRepeatableComment());
    ghidra.program.model.listing.StackFrame sf = f.getStackFrame();
    h.s(sf.getFrameSize()).s(sf.getLocalSize()).s(sf.getParameterOffset()).s(sf.getReturnAddressOffset());
    for (ghidra.program.model.listing.Variable v : f.getAllVariables())
      h.s(v.getName()).s(v.getVariableStorage()).s(v.getFirstUseOffset()).s(v.getSource()).s(type(v.getDataType())[0]);
    for (ghidra.program.model.address.AddressRange r : body) {
      byte[] by = new byte[(int) r.getLength()];
      try { MEM.getBytes(r.getMinAddress(), by); h.b(by); } catch (Exception e) { h.s("nb"); }
    }
    ghidra.program.model.listing.CodeUnitIterator cus = LS.getCodeUnits(body, true);
    while (cus.hasNext()) {
      ghidra.program.model.listing.CodeUnit cu = cus.next();
      ghidra.program.model.address.Address a = cu.getAddress();
      h.s(a);
      for (ghidra.program.model.listing.CommentType ct : ghidra.program.model.listing.CommentType.values()) {
        String c = cu.getComment(ct);
        if (c != null) h.s(ct).s(c);
      }
      for (ghidra.program.model.symbol.Symbol s : STB.getSymbols(a)) h.s(s.getName(true)).s(s.getSymbolType()).s(s.isPrimary()).s(s.getSource());
      if (cu instanceof ghidra.program.model.listing.Instruction) {
        ghidra.program.model.listing.Instruction in = (ghidra.program.model.listing.Instruction) cu;
        h.s(in.getFlowOverride()).s(in.isFallThroughOverridden()).s(in.getFallThrough()).s(in.getLength());
        for (int oi = 0; oi < in.getNumOperands(); oi++) {
          for (ghidra.program.model.symbol.Equate eq : EQT.getEquates(a, oi)) h.s(oi).s(eq.getName()).s(eq.getValue());
          for (Object o : in.getOpObjects(oi)) {
            if (!(o instanceof ghidra.program.model.scalar.Scalar)) continue;
            long v = ((ghidra.program.model.scalar.Scalar) o).getUnsignedValue();
            try {
              ghidra.program.model.address.Address t = a.getAddressSpace().getAddress(v);
              if (MEM.contains(t) && !body.contains(t)) h.s("k").s(at(t));
            } catch (Exception e) { }
          }
        }
      } else {
        h.s("data").s(type(((ghidra.program.model.listing.Data) cu).getDataType())[0]);
      }
      for (ghidra.program.model.symbol.Reference r : RMS.getReferencesFrom(a)) {
        ghidra.program.model.address.Address t = r.getToAddress();
        h.s(t).s(r.getReferenceType()).s(r.getOperandIndex()).s(r.isPrimary()).s(r.getSource());
        if ((t.isMemoryAddress() || t.isExternalAddress()) && !body.contains(t)) h.s(at(t));
      }
    }
    for (ghidra.program.model.lang.Register rg : PCX.getRegistersWithValues()) {
      for (ghidra.program.model.address.AddressRange r : body) {
        ghidra.program.model.address.AddressRangeIterator vi = PCX.getRegisterValueAddressRanges(rg, r.getMinAddress(), r.getMaxAddress());
        while (vi.hasNext()) {
          ghidra.program.model.address.AddressRange vr = vi.next();
          ghidra.program.model.lang.RegisterValue rv = PCX.getNonDefaultValue(rg, vr.getMinAddress());
          if (rv != null && rv.hasAnyValue()) h.s(rg.getName()).s(vr).s(rv.getUnsignedValueIgnoreMask());
        }
      }
    }
    return h.done();
  }
  /** Everything that moves every decompile at once. */
  String program() {
    H h = new H();
    h.s(ghidra.framework.Application.getApplicationVersion()).s(prog.getLanguageID()).s(prog.getCompilerSpec().getCompilerSpecID()).s(prog.getImageBase());
    for (ghidra.program.model.lang.PrototypeModel pm : prog.getCompilerSpec().getAllModels()) h.s(pm.getName()).s(pm.getExtrapop()).s(pm.getStackshift());
    for (ghidra.program.model.mem.MemoryBlock b : MEM.getBlocks())
      h.s(b.getName()).s(b.getStart()).s(b.getEnd()).s(b.getFlags()).s(b.isInitialized()).s(b.isVolatile());
    ghidra.program.model.data.DataOrganization dor = dtm.getDataOrganization();
    h.s(dor.getPointerSize()).s(dor.getIntegerSize()).s(dor.getLongSize()).s(dor.getDefaultAlignment()).s(dor.isBigEndian());
    try {
      ghidra.framework.options.Options ext = prog.getOptions("Specification Extensions");
      for (String n : ext.getOptionNames()) h.s(n).s(ext.getValueAsString(n));
    } catch (Exception e) { h.s("noext"); }
    return h.done();
  }
}
final Stamper S = new Stamper();
`;

/**
 * The stamps for a batch: `P <program>`, then `F <entry> <self>` per function and
 * `T <id> <full> <shape>` per requested type id. `__ITEMS__` is `;`-separated entries,
 * `__TYPES__` `;`-separated type ids.
 */
export const FUNCTION_STAMPS_SCRIPT = `
${STAMPER_JAVA}
final java.util.List<String> todo = new java.util.ArrayList<>();
for (String a : "__ITEMS__".split(";")) if (a.length() > 0) todo.add(a);
final java.util.concurrent.ConcurrentLinkedQueue<String> queue = new java.util.concurrent.ConcurrentLinkedQueue<>(todo);
final java.util.concurrent.ConcurrentHashMap<String, String> rows = new java.util.concurrent.ConcurrentHashMap<>();
java.util.List<Thread> threads = new java.util.ArrayList<>();
for (int ti = 0; ti < Math.max(1, Math.min(__THREADS__, todo.size())); ti++) {
  Thread th = new Thread(() -> {
    String a;
    while ((a = queue.poll()) != null) {
      try {
        ghidra.program.model.listing.Function fn = FMS.getFunctionAt(prog.getAddressFactory().getAddress(a));
        rows.put(a, fn == null ? "none" : S.fn(fn));
      } catch (Exception e) { rows.put(a, "error"); }
    }
  });
  th.start();
  threads.add(th);
}
for (Thread th : threads) th.join();
StringBuilder sb = new StringBuilder();
sb.append("P\\t").append(S.program()).append('\\n');
for (String a : todo) sb.append("F\\t").append(a).append('\\t').append(rows.getOrDefault(a, "error")).append('\\n');
for (String k : "__TYPES__".split(";")) {
  if (k.length() == 0) continue;
  String[] t = S.typeById(Long.parseLong(k));
  sb.append("T\\t").append(k).append('\\t').append(t[0]).append('\\t').append(t[1]).append('\\n');
}
println(sb.toString());
`;

export function functionStampsScript(entries: string[], typeIds: Iterable<string>, threads = 8): string {
  return FUNCTION_STAMPS_SCRIPT
    .replace('__ITEMS__', entries.join(';'))
    .replace('__TYPES__', [...typeIds].join(';'))
    .replace('__THREADS__', String(threads));
}

export interface TypeStamp { full: string; shape: string }

export interface FunctionStamps {
  program: string | null;
  /** Entry -> self stamp; `none` when no function sits there, `error` when it could not be read. */
  self: Map<string, string>;
  types: Map<string, TypeStamp>;
}

export function parseFunctionStamps(output: string): FunctionStamps {
  const out: FunctionStamps = { program: null, self: new Map(), types: new Map() };
  for (const raw of output.split('\n')) {
    const c = raw.replace(/\r$/, '').split('\t');
    if (c[0] === 'P' && c.length >= 2) out.program = c[1];
    else if (c[0] === 'F' && c.length >= 3) out.self.set(normalizeEntry(c[1]), c[2]);
    else if (c[0] === 'T' && c.length >= 4) out.types.set(c[1], { full: c[2], shape: c[3] });
  }
  return out;
}

export function normalizeEntry(a: string): string {
  return a.replace(/^0x/i, '').toLowerCase().padStart(8, '0');
}

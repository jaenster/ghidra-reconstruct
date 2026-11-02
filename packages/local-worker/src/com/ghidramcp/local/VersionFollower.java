package com.ghidramcp.local;

import com.ghidramcp.DecompilerPool;
import com.ghidramcp.GhidraContext;
import com.ghidramcp.ChangeJournal;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import ghidra.app.decompiler.DecompInterface;
import ghidra.framework.client.RepositoryAdapter;
import ghidra.framework.model.DomainFile;
import ghidra.framework.store.FolderItem;
import ghidra.framework.store.remote.RemoteFileSystem;
import ghidra.program.database.ProgramContentHandler;
import ghidra.program.flatapi.FlatProgramAPI;
import ghidra.program.model.address.Address;
import ghidra.program.model.address.AddressRange;
import ghidra.program.model.address.AddressSet;
import ghidra.program.model.address.AddressSetView;
import ghidra.program.model.data.Category;
import ghidra.program.model.data.DataType;
import ghidra.program.model.listing.Data;
import ghidra.program.model.listing.Function;
import ghidra.program.model.listing.Program;
import ghidra.program.model.listing.ProgramChangeSet;
import ghidra.program.model.mem.MemoryBlock;
import ghidra.program.model.symbol.Symbol;
import ghidra.program.model.symbol.SymbolIterator;
import ghidra.program.model.symbol.SymbolType;
import ghidra.util.task.TaskMonitor;


import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * A change journal for a read-only program, derived from the Ghidra Server's version
 * history instead of from listener events.
 *
 * The worker opens the program read-only, so nothing is ever edited here and a
 * DomainObjectListener would hear nothing. Edits happen elsewhere and reach the server
 * as check-ins. Every check-in stores what it changed, and
 * {@link ProgramContentHandler#getChangeSet} returns the union of those records from any
 * older version up to the LATEST one (asking for a range that ends below the latest
 * returns an empty set, so the end is always the latest and is re-checked afterwards).
 *
 * <h2>Sequence numbers are versions</h2>
 *
 * An event's seq is {@code version * SEQ_PER_VERSION + i}, where version is the one the
 * events bring the consumer to. A consumer that has applied seq N is at version
 * {@code N / SEQ_PER_VERSION}, and the next call asks the server for everything after
 * that version. Nothing is stored here: the journal is a function of the server's
 * history, so a worker restart or a fresh machine resumes exactly, and the only way to
 * lose a position is a server whose latest version is below it, which a consumer sees as
 * a head below its own seq.
 *
 * <h2>Structural changes are reported, not interpreted</h2>
 *
 * A consumer that keeps a model per function cannot apply a function that appeared or
 * vanished, a renamed namespace or category, or a moved memory block from a single
 * event. Those come out as {@code target=program} events, which tell it to resynchronise
 * from scratch. Appearance and disappearance are found by looking up every function
 * that overlaps a changed address in the other version. Only what the change records
 * name is examined: reading every function of a remotely opened program costs a server
 * round trip per database buffer (measured 68-120 s), which is not a per-check-in cost.
 * A change the records do not carry is therefore not seen here; the batch regen and the
 * daemon's full_regen remain the check for that.
 *
 * Replying to {@code get_changes} moves the open program to the latest version. The
 * caller holds every other request until it returns (see StdioWorker), so no read ever
 * straddles two versions.
 */
final class VersionFollower {
    static final long SEQ_PER_VERSION = 1_000_000L;

    /** Above this many events, the per-symbol path loses to a resync. */
    private static final int MAX_EVENTS = 200_000;

    private final GhidraContext ctx;
    private final String programPath;
    private final String folder;
    private final String name;

    /** The version the active program was opened at. */
    private int openVersion;

    /** The last answer, so a consumer reading it in pages or twice gets the same events. */
    private int cachedFrom = -1;
    private int cachedTo = -1;
    private List<JsonObject> cachedEvents = List.of();

    VersionFollower(GhidraContext ctx, String programPath, int openVersion) {
        this.ctx = ctx;
        this.programPath = programPath;
        int slash = programPath.lastIndexOf('/');
        this.folder = slash <= 0 ? "/" : programPath.substring(0, slash);
        this.name = programPath.substring(slash + 1);
        this.openVersion = openVersion;
    }

    int openVersion() {
        return openVersion;
    }

    /** The latest version on the server, asked fresh: the project's cached view lags. */
    int latestVersion() throws Exception {
        return repository().getItem(folder, name).getVersion();
    }

    /**
     * Everything after {@code since}, as the cloud worker's get_changes answers it, plus
     * {@code version}: the program version the open program is now at.
     */
    JsonObject getChanges(long since, int limit, StdioLog log) throws Exception {
        int latest = latestVersion();
        int from = since <= 0 ? openVersion : (int) (since / SEQ_PER_VERSION);

        JsonObject result = new JsonObject();
        JsonArray out = new JsonArray();
        result.add("events", out);
        if (from >= latest) {
            // Caught up, or ahead of the server (a rolled-back history): a head below the
            // consumer's seq is how it learns the second.
            if (openVersion < latest) moveTo(latest, log);
            result.addProperty("head", from > latest ? latest * SEQ_PER_VERSION : Math.max(since, latest * SEQ_PER_VERSION));
            result.addProperty("version", openVersion);
            return result;
        }

        if (from != cachedFrom || latest != cachedTo) {
            cachedEvents = compute(from, latest, log);
            cachedFrom = from;
            cachedTo = openVersion;
        }
        List<JsonObject> events = cachedEvents;
        long head = events.isEmpty() ? cachedTo * SEQ_PER_VERSION : events.get(events.size() - 1).get("seq").getAsLong();
        for (JsonObject e : events) {
            if (e.get("seq").getAsLong() <= since) continue;
            if (out.size() >= limit) break;
            out.add(e);
        }
        result.addProperty("head", head);
        result.addProperty("version", openVersion);
        return result;
    }

    // ============== Computing one step ==============

    private List<JsonObject> compute(int from, int to, StdioLog log) throws Exception {
        long t0 = System.currentTimeMillis();
        FolderItem item = new RemoteFileSystem(repository()).getItem(folder, name);
        ProgramChangeSet cs = (ProgramChangeSet) new ProgramContentHandler().getChangeSet(item, from, to);
        log.info("  change set v" + from + "..v" + to + " read in " + (System.currentTimeMillis() - t0) + " ms");
        // getChangeSet only answers for a range ending at the latest version. A check-in
        // that landed in between would make this set silently empty or short; take the
        // next one instead.
        int latestNow = latestVersion();
        if (latestNow != to) {
            log.info("version moved from " + to + " to " + latestNow + " while reading its changes; reading again");
            return compute(from, latestNow, log);
        }

        DomainFile df = ctx.getProjectData().getFile(programPath);
        Program active = ctx.getProgram();
        Program oldP = openVersion == from ? active
            : (Program) df.getReadOnlyDomainObject(this, from, TaskMonitor.DUMMY);
        Program newP;
        List<JsonObject> events;
        try {
            long t1 = System.currentTimeMillis();
            newP = openVersion == to ? active
                : (Program) df.getReadOnlyDomainObject(ctx, to, TaskMonitor.DUMMY);
            log.info("  opened v" + to + " in " + (System.currentTimeMillis() - t1) + " ms");
            long t2 = System.currentTimeMillis();
            events = translate(cs, oldP, newP, to, log);
            log.info("  translated in " + (System.currentTimeMillis() - t2) + " ms");
        } finally {
            if (oldP != active) oldP.release(this);
        }
        if (newP != active) {
            activate(newP, to);
            active.release(ctx);
        }
        log.info("Game.exe v" + from + " -> v" + to + ": " + events.size() + " event(s) in "
            + (System.currentTimeMillis() - t0) + " ms");
        return events;
    }

    /** Swap the active program for one at a newer version, with a decompiler of its own. */
    private void moveTo(int version, StdioLog log) throws Exception {
        DomainFile df = ctx.getProjectData().getFile(programPath);
        Program old = ctx.getProgram();
        Program fresh = (Program) df.getReadOnlyDomainObject(ctx, version, TaskMonitor.DUMMY);
        activate(fresh, version);
        old.release(ctx);
        log.info("moved to Game.exe v" + version + " (no changes recorded in between)");
    }

    private void activate(Program fresh, int version) {
        String path = ctx.getActiveProgramPath();
        DecompilerPool pool = ctx.getDecompPools().remove(path);
        if (pool != null) pool.shutdown();
        DecompInterface decomp = ctx.getDecompilers().remove(path);
        if (decomp != null) decomp.dispose();
        ChangeJournal journal = ctx.getChangeJournal(path);
        if (journal != null) journal.detach();
        if (ctx.getDirtyTracker() != null) ctx.getDirtyTracker().detach();

        FlatProgramAPI api = new FlatProgramAPI(fresh);
        DecompInterface fresher = DecompilerPool.createDecompiler(fresh);
        ctx.setProgram(fresh);
        ctx.setFlatApi(api);
        ctx.setDecompiler(fresher);
        ctx.registerProgram(path, fresh, api, fresher);
        openVersion = version;
    }

    private RepositoryAdapter repository() throws Exception {
        RepositoryAdapter repo = ctx.getServerProject().getRepository();
        if (!repo.isConnected()) repo.connect();
        return repo;
    }

    // ============== Change set -> events ==============

    private List<JsonObject> translate(ProgramChangeSet cs, Program oldP, Program newP, int to, StdioLog log) {
        long tt = System.currentTimeMillis();
        Map<String, String[]> events = new LinkedHashMap<>();   // kind+key -> {kind,target,key,old,new}

        // Memory map, language, image base: nothing per symbol describes these.
        if (!memoryLayout(oldP).equals(memoryLayout(newP))) {
            put(events, "memory.changed", ChangeJournal.TARGET_PROGRAM, "*", null, null);
        }

        // Addresses: code, data, comments, references, equates, function records.
        AddressSet changed = memoryOnly(cs.getAddressSet());
        changed.add(memoryOnly(cs.getRegisterAddressSet()));
        for (Program p : new Program[] { newP, oldP }) {
            Program other = p == newP ? oldP : newP;
            Iterator<Function> it = p.getFunctionManager().getFunctionsOverlapping(changed);
            while (it.hasNext()) {
                Function f = it.next();
                Function there = other.getFunctionManager().getFunctionAt(f.getEntryPoint());
                if (there == null) {
                    // Appeared or vanished: the consumer's per-function model cannot take it
                    // in one step, so it resynchronises.
                    put(events, p == newP ? "function.added" : "function.removed", ChangeJournal.TARGET_PROGRAM, f.getEntryPoint().toString(), null, null);
                } else if (!f.getBody().equals(there.getBody())) {
                    put(events, ChangeJournal.KIND_FUNCTION_BODY, ChangeJournal.TARGET_FUNCTION, f.getEntryPoint().toString(), null, null);
                } else {
                    put(events, ChangeJournal.KIND_FUNCTION_CHANGED, ChangeJournal.TARGET_FUNCTION, f.getEntryPoint().toString(), null, null);
                }
            }
        }
        AddressSet outside = new AddressSet(changed);
        for (Program p : new Program[] { newP, oldP }) {
            Iterator<Function> it = p.getFunctionManager().getFunctionsOverlapping(changed);
            while (it.hasNext()) outside.delete(it.next().getBody());
        }
        for (Program p : new Program[] { newP, oldP }) {
            SymbolIterator syms = p.getSymbolTable().getPrimarySymbolIterator(outside, true);
            while (syms.hasNext()) {
                put(events, ChangeJournal.KIND_DATA_CHANGED, ChangeJournal.TARGET_GLOBAL, syms.next().getAddress().toString(), null, null);
            }
            for (AddressRange r : outside) {
                Data d = p.getListing().getDataContaining(r.getMinAddress());
                if (d != null && d.isDefined()) {
                    put(events, ChangeJournal.KIND_DATA_CHANGED, ChangeJournal.TARGET_GLOBAL, d.getAddress().toString(), null, null);
                }
            }
        }

        log.info("    addresses in " + (System.currentTimeMillis() - tt) + " ms");
        tt = System.currentTimeMillis();
        // Symbols: renames, new and removed labels, parameters and locals.
        List<Long> symbolIds = new ArrayList<>();
        for (long id : cs.getSymbolChanges()) symbolIds.add(id);
        for (long id : cs.getSymbolAdditions()) symbolIds.add(id);
        for (long id : symbolIds) {
            Symbol now = newP.getSymbolTable().getSymbol(id);
            Symbol was = oldP.getSymbolTable().getSymbol(id);
            Symbol any = now != null ? now : was;
            if (any == null) continue;
            SymbolType type = any.getSymbolType();
            if (type == SymbolType.NAMESPACE || type == SymbolType.CLASS || type == SymbolType.LIBRARY) {
                // Every function and global under it moves file and qualification.
                if (now == null || was == null || !now.getName(true).equals(was.getName(true))) {
                    put(events, "namespace.changed", ChangeJournal.TARGET_PROGRAM, any.getName(true), was == null ? null : was.getName(true), now == null ? null : now.getName(true));
                }
                continue;
            }
            String[] tk = classify(any, any == now ? newP : oldP);
            if (tk == null) continue;
            boolean renamed = now != null && was != null && !now.getName().equals(was.getName())
                && !(now.getParentNamespace() instanceof Function);
            if (renamed) {
                put(events, ChangeJournal.KIND_SYMBOL_RENAMED, tk[0], tk[1], was.getName(), now.getName());
            } else {
                String kind = ChangeJournal.TARGET_FUNCTION.equals(tk[0]) ? ChangeJournal.KIND_FUNCTION_CHANGED : ChangeJournal.KIND_DATA_CHANGED;
                put(events, kind, tk[0], tk[1], null, null);
            }
        }

        log.info("    symbols in " + (System.currentTimeMillis() - tt) + " ms");
        tt = System.currentTimeMillis();
        // Data types, by id in both managers.
        List<Long> typeIds = new ArrayList<>();
        for (long id : cs.getDataTypeChanges()) typeIds.add(id);
        for (long id : cs.getDataTypeAdditions()) typeIds.add(id);
        for (long id : typeIds) {
            DataType now = newP.getDataTypeManager().getDataType(id);
            DataType was = oldP.getDataTypeManager().getDataType(id);
            if (now != null && was != null) {
                if (!now.getPathName().equals(was.getPathName())) {
                    put(events, ChangeJournal.KIND_DATATYPE_RENAMED, ChangeJournal.TARGET_DATATYPE, now.getPathName(), was.getPathName(), now.getPathName());
                } else {
                    put(events, ChangeJournal.KIND_DATATYPE_CHANGED, ChangeJournal.TARGET_DATATYPE, now.getPathName(), was.getPathName(), now.getPathName());
                }
            } else if (now != null) {
                put(events, ChangeJournal.KIND_DATATYPE_ADDED, ChangeJournal.TARGET_DATATYPE, now.getPathName(), null, now.getPathName());
            } else if (was != null) {
                put(events, ChangeJournal.KIND_DATATYPE_REMOVED, ChangeJournal.TARGET_DATATYPE, was.getPathName(), was.getPathName(), null);
            }
        }
        // A renamed or moved category moves every type in it without touching their ids.
        for (long id : cs.getCategoryChanges()) {
            Category now = newP.getDataTypeManager().getCategory(id);
            Category was = oldP.getDataTypeManager().getCategory(id);
            if (now != null && was != null && !now.getCategoryPathName().equals(was.getCategoryPathName())) {
                put(events, "category.moved", ChangeJournal.TARGET_PROGRAM, now.getCategoryPathName(), was.getCategoryPathName(), now.getCategoryPathName());
            }
        }

        if (events.size() > MAX_EVENTS) {
            events.clear();
            put(events, "too.many.changes", ChangeJournal.TARGET_PROGRAM, "*", null, null);
        }

        List<JsonObject> out = new ArrayList<>(events.size());
        long seq = to * SEQ_PER_VERSION;
        for (String[] e : events.values()) out.add(event(++seq, to, e[0], e[1], e[2], e[3], e[4]));
        return out;
    }

    private static JsonObject event(long seq, int to, String kind, String target, String key, String oldName, String newName) {
        JsonObject o = new JsonObject();
        o.addProperty("seq", seq);
        o.addProperty("mod", to);
        o.addProperty("ts", System.currentTimeMillis());
        o.addProperty("kind", kind);
        o.addProperty("target", target);
        o.addProperty("key", key);
        if (oldName != null) o.addProperty("oldName", oldName);
        if (newName != null) o.addProperty("newName", newName);
        o.addProperty("txDescription", "Game.exe v" + to);
        return o;
    }

    /** Parameters and locals roll up to their function, as in ChangeJournal.classifySymbol. */
    private static String[] classify(Symbol sym, Program p) {
        if (sym.getParentNamespace() instanceof Function parent) {
            return new String[] { ChangeJournal.TARGET_FUNCTION, parent.getEntryPoint().toString() };
        }
        Address addr = sym.getAddress();
        if (addr == null || !addr.isMemoryAddress()) return null;
        Function f = p.getFunctionManager().getFunctionAt(addr);
        if (f == null) f = p.getFunctionManager().getFunctionContaining(addr);
        if (f != null) return new String[] { ChangeJournal.TARGET_FUNCTION, f.getEntryPoint().toString() };
        return new String[] { ChangeJournal.TARGET_GLOBAL, addr.toString() };
    }

    private static AddressSet memoryOnly(AddressSetView set) {
        AddressSet out = new AddressSet();
        for (AddressRange r : set) {
            if (r.getMinAddress().isMemoryAddress()) out.add(r);
        }
        return out;
    }

    private static String memoryLayout(Program p) {
        StringBuilder sb = new StringBuilder();
        sb.append(p.getLanguageID()).append('|').append(p.getImageBase()).append('|');
        for (MemoryBlock b : p.getMemory().getBlocks()) {
            sb.append(b.getName()).append('@').append(b.getStart()).append('-').append(b.getEnd())
              .append(b.isInitialized() ? 'i' : 'u').append(';');
        }
        return sb.toString();
    }

    private static void put(Map<String, String[]> events, String kind, String target, String key, String oldName, String newName) {
        String k = kind + " " + key;
        String[] existing = events.get(k);
        if (existing != null && oldName == null && newName == null) return;
        events.put(k, new String[] { kind, target, key, oldName, newName });
    }

    /** stderr logging, so stdout stays the protocol. */
    interface StdioLog {
        void info(String message);
    }
}

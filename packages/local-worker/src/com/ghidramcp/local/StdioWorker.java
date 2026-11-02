package com.ghidramcp.local;

import com.ghidramcp.CommandDispatcher;
import com.ghidramcp.CommandHandler;
import com.ghidramcp.GhidraEngine;
import com.ghidramcp.logging.Logger;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import ghidra.GhidraApplicationLayout;
import ghidra.framework.Application;
import ghidra.framework.HeadlessGhidraApplicationConfiguration;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileDescriptor;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Future;

/**
 * The ghidra-mcp worker, driven over stdin/stdout instead of through the daemon.
 *
 * It opens one program from a Ghidra Server read-only and answers the same
 * commands with the same {@link CommandHandler} the daemon's workers run, so the
 * extraction sees byte-for-byte the results it gets from the daemon, minus the
 * network round trip per call. Nothing here formats or filters a result.
 *
 * Protocol, one JSON object per line:
 *   stdin  {"id": n, "command": "...", "params": {...}}
 *   stdout {"ready": true, ...} once the program is open, then
 *          {"id": n, "success": true, "result": {...}}
 *          {"id": n, "success": false, "error": "..."}
 * Replies arrive in completion order, not request order: reads run in parallel.
 * Every log line goes to stderr; stdout carries the protocol only.
 *
 * Usage: StdioWorker --ghidra-server host:port --repo R --program /path --server-user U
 *                    --project DIR [--local-copy]
 * The password is read from GHIDRA_SERVER_PASSWORD, as the daemon's worker does.
 * GHIDRA_HOME names the Ghidra install the classpath comes from.
 */
public final class StdioWorker {
    private static final Gson gson = new Gson();

    public static void main(String[] args) throws Exception {
        // The worker's Logger and Ghidra print to System.out. Keep the real stdout for
        // the protocol and send everything else to stderr.
        PrintStream protocolOut = new PrintStream(new FileOutputStream(FileDescriptor.out), false,
                                                  StandardCharsets.UTF_8);
        System.setOut(System.err);

        String serverHostPort = null, repo = null, program = null, user = null, project = null;
        boolean localCopy = false;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--ghidra-server": serverHostPort = args[++i]; break;
                case "--repo": repo = args[++i]; break;
                case "--program": program = args[++i]; break;
                case "--server-user": user = args[++i]; break;
                case "--project": project = args[++i]; break;
                // Work on a local copy of the version instead of reading the server per buffer.
                case "--local-copy": localCopy = true; break;
                default: throw new IllegalArgumentException("unknown argument " + args[i]);
            }
        }
        if (serverHostPort == null || repo == null || program == null || user == null || project == null) {
            System.err.println("Usage: StdioWorker --ghidra-server host:port --repo R --program /path "
                               + "--server-user U --project DIR   (password in GHIDRA_SERVER_PASSWORD)");
            System.exit(2);
        }
        String password = System.getenv("GHIDRA_SERVER_PASSWORD");
        if (password == null || password.isEmpty()) {
            System.err.println("GHIDRA_SERVER_PASSWORD is not set");
            System.exit(2);
        }

        // The worker's own init tries GhidraJarApplicationLayout first, which on a plain
        // lib/* classpath finds no module data dirs and so no *.serial.filter files: the
        // client serial filter then rejects every class the server sends on connect.
        // Initialise from the install layout before the worker gets the chance.
        // The login name is the user.name Ghidra caches at init, so set it first: the
        // worker's own setProperty comes too late and the server sees the OS user.
        System.setProperty("user.name", user);
        String ghidraHome = System.getenv("GHIDRA_HOME");
        if (ghidraHome == null || ghidraHome.isEmpty()) {
            System.err.println("GHIDRA_HOME is not set");
            System.exit(2);
        }
        Application.initializeApplication(new GhidraApplicationLayout(new File(ghidraHome)),
                                          new HeadlessGhidraApplicationConfiguration());

        Logger log = Logger.create("StdioWorker", "local", "local");
        GhidraEngine engine = new GhidraEngine(project, log.child("GhidraEngine"));
        String[] hp = serverHostPort.split(":", 2);
        char[] pw = password.toCharArray();
        long openStart = System.currentTimeMillis();
        try {
            engine.openServerProgram(hp[0], hp.length > 1 ? Integer.parseInt(hp[1]) : 13100,
                                     repo, program, user, pw, true);
        } finally {
            java.util.Arrays.fill(pw, '\0');
        }

        CommandHandler handler = new CommandHandler(engine, log.child("CommandHandler"));
        CommandDispatcher dispatcher = new CommandDispatcher(handler, log.child("Dispatcher"));

        Writer out = new OutputStreamWriter(protocolOut, StandardCharsets.UTF_8);
        // The journal this read-only worker can offer: the server's version history.
        VersionFollower follower = new VersionFollower(engine.getContext(), program,
            serverVersion(engine, program));
        if (localCopy) follower.localize(m -> System.err.println("[VersionFollower] " + m));
        JsonObject ready = new JsonObject();
        ready.addProperty("ready", true);
        ready.addProperty("openMs", System.currentTimeMillis() - openStart);
        ready.addProperty("version", follower.openVersion());
        reply(out, ready);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isBlank()) continue;
            JsonObject req = JsonParser.parseString(line).getAsJsonObject();
            long id = req.get("id").getAsLong();
            String command = req.get("command").getAsString();
            JsonObject params = req.has("params") ? req.getAsJsonObject("params") : new JsonObject();
            if ("shutdown".equals(command)) break;

            if ("get_changes".equals(command) || "get_program_version".equals(command)) {
                // Answered on this thread, with every earlier request finished and no later
                // one started: get_changes may move the open program to a newer version,
                // and no read may straddle the swap.
                awaitIdle();
                JsonObject resp = new JsonObject();
                resp.addProperty("id", id);
                try {
                    JsonObject result;
                    if ("get_changes".equals(command)) {
                        long since = params.has("since") && !params.get("since").isJsonNull() ? params.get("since").getAsLong() : 0;
                        int limit = params.has("limit") && !params.get("limit").isJsonNull() ? params.get("limit").getAsInt() : 10000;
                        if (limit <= 0 || limit > 100000) limit = 10000;
                        result = follower.getChanges(since, limit, m -> System.err.println("[VersionFollower] " + m));
                    } else {
                        result = new JsonObject();
                        result.addProperty("version", follower.openVersion());
                        result.addProperty("latest", follower.latestVersion());
                    }
                    resp.addProperty("success", true);
                    resp.add("result", result);
                } catch (Exception e) {
                    e.printStackTrace(System.err);
                    resp = failure(id, e);
                }
                reply(out, resp);
                continue;
            }

            Future<JsonObject> future;
            try {
                future = dispatcher.dispatch(command, params);
            } catch (Exception e) {
                reply(out, failure(id, e));
                continue;
            }
            beginRequest();
            // Reads complete on the dispatcher's pool; answer each as it finishes.
            Thread.ofVirtual().start(() -> {
                JsonObject resp;
                try {
                    JsonObject result = future.get();
                    resp = new JsonObject();
                    resp.addProperty("id", id);
                    resp.addProperty("success", true);
                    resp.add("result", result);
                } catch (ExecutionException e) {
                    resp = failure(id, e.getCause() != null ? e.getCause() : e);
                } catch (Exception e) {
                    resp = failure(id, e);
                }
                reply(out, resp);
                endRequest();
            });
        }

        dispatcher.shutdown();
        engine.close(false);
        System.exit(0);
    }

    private static final Object idle = new Object();
    private static int inFlight = 0;

    private static void beginRequest() {
        synchronized (idle) { inFlight++; }
    }

    private static void endRequest() {
        synchronized (idle) { if (--inFlight == 0) idle.notifyAll(); }
    }

    private static void awaitIdle() throws InterruptedException {
        synchronized (idle) { while (inFlight > 0) idle.wait(); }
    }

    /** The version the read-only program was opened at: the latest when it opened. */
    private static int serverVersion(GhidraEngine engine, String programPath) throws Exception {
        ghidra.framework.model.DomainFile df = engine.getContext().getProjectData().getFile(programPath);
        return df.getLatestVersion();
    }

    private static JsonObject failure(long id, Throwable e) {
        JsonObject resp = new JsonObject();
        resp.addProperty("id", id);
        resp.addProperty("success", false);
        resp.addProperty("error", e.getMessage() != null ? e.getMessage() : e.toString());
        return resp;
    }

    private static void reply(Writer out, JsonObject obj) {
        String text = gson.toJson(obj);
        synchronized (out) {
            try {
                out.write(text);
                out.write('\n');
                out.flush();
            } catch (Exception e) {
                System.err.println("[StdioWorker] stdout write failed: " + e.getMessage());
                System.exit(1);
            }
        }
    }
}

package com.ghidramcp.local;

import ghidra.framework.model.DomainFile;
import ghidra.util.task.TaskMonitor;

import java.util.Set;

/**
 * Everything the worker may do with a checkout, and nothing else.
 *
 * The worker checks Game.exe out only to have a local copy that follows the server one
 * version at a time. It must never put anything back: no check-in, no save to the
 * server, no exclusive checkout that would block a writer, and never touching anyone
 * else's checkout. Three things make that hold:
 *
 * <ul>
 * <li>This class is the only code that holds the checked-out DomainFile for a state
 * change, and it has no way to check in, save or undo a checkout other than the one it
 * took itself.</li>
 * <li>The program is only ever opened read-only, so the checkout never has local
 * changes; {@link #update} refuses to run if it ever does, rather than merge them.</li>
 * <li>{@link #allows} is the only set of commands a worker holding a checkout answers;
 * every editing command is refused before it reaches the dispatcher.</li>
 * </ul>
 */
final class CheckoutGuard {
    /** What the reconstruction asks a worker for (reconstruct/src/local-worker.ts). */
    private static final Set<String> ALLOWED = Set.of(
        "list_programs", "get_program_info", "list_functions", "get_function_info",
        "decompile", "batch_decompile", "get_global_variables", "read_data_value",
        "list_data_types", "get_data_type", "list_segments", "list_strings",
        "list_namespaces", "list_comments", "execute_script",
        "get_changes", "get_program_version", "shutdown");

    private final DomainFile file;
    private boolean ownCheckout;

    CheckoutGuard(DomainFile file) {
        this.file = file;
    }

    /** May a worker holding a checkout answer this command? */
    static boolean allows(String command) {
        return ALLOWED.contains(command);
    }

    /** Take a non-exclusive checkout, or keep the one this project already holds. */
    void checkout(TaskMonitor monitor) throws Exception {
        if (file.isCheckedOut()) {
            if (file.isCheckedOutExclusive()) {
                throw new IllegalStateException("this project holds an EXCLUSIVE checkout of " + file.getPathname()
                    + "; the live worker never does, and will not use one");
            }
            refuseLocalChanges("reusing the checkout");
            return;
        }
        if (!file.checkout(false, monitor)) {
            throw new IllegalStateException("checkout of " + file.getPathname() + " was refused");
        }
        ownCheckout = true;
    }

    /** Bring the checkout to the latest version. Only ever an update: there is nothing local to merge. */
    void update(TaskMonitor monitor) throws Exception {
        refuseLocalChanges("updating");
        file.merge(true, monitor);
        refuseLocalChanges("after the update");
    }

    /** Give back the checkout this worker took; never one it found or anyone else's. */
    void release() throws Exception {
        if (!ownCheckout || !file.isCheckedOut()) return;
        refuseLocalChanges("giving the checkout back");
        file.undoCheckout(false);
        ownCheckout = false;
    }

    DomainFile file() {
        return file;
    }

    private void refuseLocalChanges(String when) {
        if (file.modifiedSinceCheckout()) {
            throw new IllegalStateException("the checkout of " + file.getPathname() + " has local changes ("
                + when + "). The live worker never edits; stopping rather than merging or keeping them.");
        }
    }
}

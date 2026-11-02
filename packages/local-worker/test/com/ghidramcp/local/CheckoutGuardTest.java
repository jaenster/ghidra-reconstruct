package com.ghidramcp.local;

import ghidra.framework.model.DomainFile;
import ghidra.util.task.TaskMonitor;

import java.lang.reflect.Proxy;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * The checkout guard refuses every way of writing back. A fake DomainFile records what
 * the guard calls on it, so no server is needed. Run by test.sh; exits non-zero on failure.
 */
public final class CheckoutGuardTest {
    private static int failures = 0;

    public static void main(String[] args) throws Exception {
        for (String c : List.of("commit", "save", "save_session", "checkin", "terminate_checkout", "rename_symbol",
                                "set_comment", "set_function_variable_name", "set_prototype", "apply_changeset",
                                "undo", "redo", "delete_function", "create_label", "import_program")) {
            check(!CheckoutGuard.allows(c), "refuses " + c);
        }
        for (String c : List.of("decompile", "batch_decompile", "get_function_info", "get_changes", "execute_script")) {
            check(CheckoutGuard.allows(c), "answers " + c);
        }

        // Local changes in the checkout: update refuses and never merges.
        List<String> calls = new ArrayList<>();
        CheckoutGuard dirty = new CheckoutGuard(fake(calls, Map.of("isCheckedOut", true, "modifiedSinceCheckout", true)));
        check(throwsOn(() -> dirty.update(TaskMonitor.DUMMY)), "update refuses a checkout with local changes");
        check(!calls.contains("merge"), "no merge with local changes");

        // An exclusive checkout already held: never used.
        calls.clear();
        CheckoutGuard exclusive = new CheckoutGuard(fake(calls, Map.of("isCheckedOut", true, "isCheckedOutExclusive", true)));
        check(throwsOn(() -> exclusive.checkout(TaskMonitor.DUMMY)), "refuses an exclusive checkout");

        // A fresh checkout is non-exclusive, and the guard gives back only its own.
        calls.clear();
        CheckoutGuard fresh = new CheckoutGuard(fake(calls, Map.of("isCheckedOut", false, "checkout", true)));
        fresh.checkout(TaskMonitor.DUMMY);
        check(calls.contains("checkout(false)"), "checks out non-exclusively");
        calls.clear();
        CheckoutGuard found = new CheckoutGuard(fake(calls, Map.of("isCheckedOut", true)));
        found.checkout(TaskMonitor.DUMMY);
        found.release();
        check(!calls.contains("undoCheckout"), "never gives back a checkout it did not take");

        // Nothing in any path checks in or saves.
        for (String forbidden : List.of("checkin", "save", "terminateCheckout")) {
            check(calls.stream().noneMatch(c -> c.startsWith(forbidden)), "never calls " + forbidden);
        }

        System.out.println(failures == 0 ? "CheckoutGuardTest: all passed" : "CheckoutGuardTest: " + failures + " failed");
        System.exit(failures == 0 ? 0 : 1);
    }

    private static DomainFile fake(List<String> calls, Map<String, Object> answers) {
        return (DomainFile) Proxy.newProxyInstance(DomainFile.class.getClassLoader(), new Class<?>[] { DomainFile.class },
            (proxy, method, a) -> {
                String name = method.getName();
                calls.add(name.equals("checkout") ? "checkout(" + a[0] + ")" : name);
                if (name.equals("checkin") || name.equals("save")) throw new AssertionError("the guard called " + name);
                Object v = answers.get(name);
                if (v != null) return v;
                if (method.getReturnType() == boolean.class) return false;
                if (method.getReturnType() == String.class) return "/windows/lod/1.14d/Game.exe";
                return null;
            });
    }

    private interface Action { void run() throws Exception; }

    private static boolean throwsOn(Action a) {
        try { a.run(); return false; } catch (Exception e) { return true; }
    }

    private static void check(boolean ok, String what) {
        if (!ok) { failures++; System.out.println("FAIL " + what); }
    }
}

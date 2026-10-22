import { act } from "react";
import { afterEach, expect, test, vi } from "vitest";
import {
    actions, authorize, button, capability, claim, click, container, deferred, hold, host,
    phases, recovery, render, rerender, response, result, serve, serveSnapshot, snapshot, unmount,
} from "./BetaMatrixRound5Harness.js";
import { AppView } from "./App.js";

afterEach(() => { vi.useRealTimers(); });

function serveContexts() {
    serve((url, init) => url.pathname.endsWith("/snapshot")
        ? response(snapshot(url.searchParams.get("ctxId")!, url.pathname.includes("/beta/") ? "beta" : "alpha"))
        : hold(init?.signal));
}

test.each(["claim", "validate", "context", "attempt"] as const)(
    "recovery suspended at %s cannot deliver into a replacement Context and settles the original claim",
    async (phase) => {
        const pending = deferred<unknown>();
        host.invoke = async (call) => {
            if (call.arguments.action === phase) return pending.promise;
            return call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
        };
        if (phase === "context") host.contextResult = pending.promise;
        serve((url, init) => url.pathname.endsWith("/snapshot")
            ? response(url.searchParams.get("ctxId") === "ctx-a" ? recovery() : snapshot("ctx-b", "beta"))
            : hold(init?.signal));
        await render(<AppView />); await authorize();
        const before = { claim: ["claim"], validate: ["claim", "validate"],
            context: ["claim", "validate"], attempt: ["claim", "validate", "attempt"] }[phase];
        expect(phases()).toEqual(before);
        await authorize("ctx-b", "beta");
        await act(async () => pending.resolve(phase === "claim" ? claim() : result({ valid: true, attempted: true })));
        expect(phases()).toEqual([...before, phase === "attempt" ? "report" : "release"]);
        expect(host.calls.every((call) => call.arguments.ctxId === "ctx-a")).toBe(true);
        expect(new Set(host.calls.map((call) => call.arguments.claimId)).size).toBe(1);
        expect(host.sent).toEqual([]);
        expect(host.contexts).toHaveLength(phase === "context" || phase === "attempt" ? 1 : 0);
        expect(container.textContent).toContain("Goal ctx-b");
        expect(container.querySelector('[role="alert"]')).toBeNull();
        expect(button("Resume Goal").disabled).toBe(false);
        expect(host.calls.at(-1)!.arguments.outcome).toBe(phase === "attempt" ? "uncertain" : undefined);
    },
);

test("a legitimate Host send already started in A reports its outcome after replacement without refreshing A", async () => {
    const send = deferred<{ isError?: boolean }>(); host.sendResult = send.promise;
    const reads: string[] = [];
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
    serve((url, init) => {
        if (!url.pathname.endsWith("/snapshot")) return hold(init?.signal);
        const ctxId = url.searchParams.get("ctxId")!; reads.push(ctxId);
        return response(ctxId === "ctx-a" ? recovery() : snapshot("ctx-b", "beta"));
    });
    await render(<AppView />); await authorize();
    expect(host.sent).toHaveLength(1); expect(phases()).toEqual(["claim", "validate", "attempt"]);
    await authorize("ctx-b", "beta");
    await act(async () => send.resolve({ isError: true }));
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(host.calls.at(-1)!.arguments).toMatchObject({ ctxId: "ctx-a", outcome: "rejected" });
    expect(reads).toEqual(["ctx-a", "ctx-b"]);
    expect(container.textContent).toContain("Goal ctx-b");
});

test("a watch that removes a directive during Host context write releases it before attempt", async () => {
    const context = deferred<unknown>(); const watch = deferred<Response>(); let watches = 0;
    host.contextResult = context.promise;
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
    let state = recovery();
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize();
    expect(host.contexts).toHaveLength(1);
    state = { ...snapshot("ctx-a", "alpha", 12), reentry: { directives: [] } };
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: state })));
    await act(async () => context.resolve({}));
    expect(phases()).toEqual(["claim", "validate", "release"]);
    expect(host.sent).toEqual([]); expect(button("Resume Goal").disabled).toBe(false);
});

test("a higher watch revision retaining the directive preserves its legitimate Host delivery", async () => {
    const context = deferred<unknown>(); const watch = deferred<Response>(); let watches = 0;
    host.contextResult = context.promise;
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
    let state = recovery();
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize();
    state = recovery(snapshot("ctx-a", "alpha", 12));
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: state })));
    await act(async () => context.resolve({}));
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(host.sent).toHaveLength(1); expect(host.calls.at(-1)!.arguments.outcome).toBe("accepted");
});

test("pre-delivery recovery failure can retry on fresh authoritative state without an equal-revision loop", async () => {
    const watch = deferred<Response>(); let watches = 0;
    let state = recovery(); host.contextError = new Error("temporary Host context failure");
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim", "validate", "release"]); expect(host.sent).toEqual([]);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("temporary Host context failure");
    host.contextError = undefined; state = recovery(snapshot("ctx-a", "alpha", 12));
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: state })));
    expect(phases()).toEqual(["claim", "validate", "release", "claim", "validate", "attempt", "report"]);
    expect(host.sent).toHaveLength(1); expect(host.contexts).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(host.calls[3]!.arguments.claimId).not.toBe(host.calls[0]!.arguments.claimId);
});

test("late recovery refresh cannot roll back a newer watch revision", async () => {
    const refresh = deferred<Response>(); const watch = deferred<Response>(); let reads = 0; let watches = 0;
    host.invoke = async () => result({ claimed: false });
    serve((url, init) => url.pathname.endsWith("/snapshot") ? ++reads === 1 ? response(recovery()) : refresh.promise
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize(); expect(reads).toBe(2);
    const newer = snapshot("ctx-a", "alpha", 15); newer.presentation.work[0]!.title = "Revision 15 work";
    await act(async () => watch.resolve(response({ changed: true, cursor: 15, snapshot: newer })));
    await act(async () => refresh.resolve(response(snapshot("ctx-a", "alpha", 12))));
    expect(container.textContent).toContain("Revision 15 work"); expect(phases()).toEqual(["claim"]);
});

test.each(["token", "liveBaseUrl"] as const)("same Context %s replacement invalidates pending action ownership", async (field) => {
    const oldAction = deferred<unknown>(); const newAction = deferred<unknown>();
    let calls = 0; host.invoke = async () => ++calls === 1 ? oldAction.promise : newAction.promise;
    const reads: string[] = []; let label = "Original session";
    serve((url, init) => {
        if (!url.pathname.endsWith("/snapshot")) return hold(init?.signal);
        reads.push(url.href); const state = snapshot(); state.presentation.work[0]!.title = label; return response(state);
    });
    await render(<AppView />); await authorize(); await click("Resume Goal");
    const replacement = { ...capability(), [field]: field === "token"
        ? "replacement-private-test-token" : capability("ctx-a", "beta").liveBaseUrl };
    label = "Replacement session";
    await act(async () => host.clients.at(-1)!.ontoolresult!({ _meta: { "portable-devshell/mcpapp": replacement } }));
    expect(button("Resume Goal").disabled).toBe(false); await click("Resume Goal");
    await act(async () => oldAction.reject(new Error("obsolete action failure")));
    expect(button("Applying…").disabled).toBe(true); expect(actions()).toHaveLength(2);
    expect(reads).toHaveLength(2); expect(container.querySelector('[role="alert"]')).toBeNull();
    await act(async () => newAction.resolve(result({ status: "applied" })));
    expect(reads).toHaveLength(3); expect(container.textContent).toContain("Replacement session");
    expect(button("Resume Goal").disabled).toBe(false);
});

test("A to B to A cannot let the original A action finish or unlock the new A action", async () => {
    const oldAction = deferred<unknown>(); const newAction = deferred<unknown>(); let calls = 0;
    host.invoke = async () => ++calls === 1 ? oldAction.promise : newAction.promise;
    serveContexts();
    await render(<AppView />); await authorize(); await click("Resume Goal");
    await authorize("ctx-b", "beta"); await authorize(); await click("Resume Goal");
    await act(async () => oldAction.resolve(result({ status: "stale" })));
    expect(button("Applying…").disabled).toBe(true); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/snapshot"))).toHaveLength(3);
    await act(async () => newAction.resolve(result({ status: "applied" })));
    expect(button("Resume Goal").disabled).toBe(false); expect(actions()).toHaveLength(2);
});

test("two immediate non-confirming clicks dispatch one operation and failure permits a fresh retry", async () => {
    const action = deferred<unknown>(); host.invoke = async () => action.promise; serveSnapshot(snapshot());
    await render(<AppView />); await authorize();
    await act(async () => { button("Resume Goal").click(); button("Resume Goal").click(); });
    expect(actions()).toHaveLength(1);
    await act(async () => action.resolve({ isError: true }));
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Workspace action was rejected.");
    expect(button("Resume Goal").disabled).toBe(false);
    host.invoke = async () => result({ status: "applied" }); await click("Resume Goal");
    expect(actions()).toHaveLength(2); expect(actions()[1]!.arguments.requestId).not.toBe(actions()[0]!.arguments.requestId);
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("confirmation is renewed after same Context capability rotation and remains usable", async () => {
    serveSnapshot(snapshot()); await render(<AppView />); await authorize(); await click("Pause Goal");
    await act(async () => host.clients.at(-1)!.ontoolresult!({ _meta: { "portable-devshell/mcpapp": {
        ...capability(), token: "rotated-private-test-token",
    } } }));
    expect(button("Pause Goal").disabled).toBe(false); await click("Pause Goal"); expect(actions()).toHaveLength(0);
    await click("Confirm Pause Goal"); expect(actions()).toHaveLength(1);
    expect(actions()[0]!.arguments).toMatchObject({ ctxId: "ctx-a", actionId: "goal-pause", expectedRevision: 11 });
});

test("a higher watch revision invalidates confirmation even when item expectedRevision is unchanged", async () => {
    const watch = deferred<Response>(); let watches = 0; const state = snapshot();
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize(); await click("Pause Goal");
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: { ...state, cursor: 12 } })));
    await click("Pause Goal"); expect(actions()).toHaveLength(0);
    await click("Confirm Pause Goal"); expect(actions()).toHaveLength(1);
    expect(actions()[0]!.arguments.expectedRevision).toBe(11);
});

test("an action refresh awaiting the response body is revalidated after Context replacement", async () => {
    const body = deferred<unknown>(); let readsA = 0;
    serve((url, init) => {
        if (!url.pathname.endsWith("/snapshot")) return hold(init?.signal);
        const ctxId = url.searchParams.get("ctxId")!;
        if (ctxId === "ctx-a" && ++readsA === 2) {
            const pending = response({}); pending.json = () => body.promise; return pending;
        }
        return response(snapshot(ctxId));
    });
    await render(<AppView />); await authorize(); await click("Resume Goal"); expect(readsA).toBe(2);
    await authorize("ctx-b", "beta");
    await act(async () => body.resolve(snapshot("ctx-a", "alpha", 99)));
    expect(container.textContent).toContain("Goal ctx-b"); expect(container.textContent).not.toContain("Goal ctx-a");
    expect(button("Resume Goal").disabled).toBe(false);
});

test("watch retry retains its revision floor when an action refresh overtook the original watch cursor", async () => {
    vi.useFakeTimers();
    const watch = deferred<Response>(); const recoveryWatch = deferred<Response>();
    let reads = 0; let watches = 0; const cursors: string[] = [];
    serve((url, init) => {
        if (url.pathname.endsWith("/snapshot")) {
            reads++; const state = snapshot("ctx-a", "alpha", reads === 2 ? 20 : 11);
            state.presentation.work[0]!.title = `Revision ${state.cursor} work`; return response(state);
        }
        cursors.push(url.searchParams.get("cursor")!);
        watches++;
        return watches === 1 ? watch.promise : watches === 2 ? recoveryWatch.promise : hold(init?.signal);
    });
    await render(<AppView />); await authorize(); await click("Resume Goal");
    expect(container.textContent).toContain("Revision 20 work");
    await act(async () => watch.reject(new Error("watch interrupted")));
    expect(container.textContent).toContain("watch interrupted");
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reads).toBe(3); expect(cursors).toEqual(["11", "20"]);
    expect(container.textContent).not.toContain("Revision 11 work");
    const latest = snapshot("ctx-a", "alpha", 21); latest.presentation.work[0]!.title = "Revision 21 work";
    await act(async () => recoveryWatch.resolve(response({ changed: true, cursor: 21, snapshot: latest })));
    expect(container.textContent).toContain("Revision 21 work"); expect(button("Resume Goal").disabled).toBe(false);
    expect(container.textContent).not.toContain("watch interrupted");
});

test.each(["close", "teardown", "unmount"] as const)("Host %s invalidates pending work before its late completion", async (event) => {
    const action = deferred<unknown>(); host.invoke = async () => action.promise; serveSnapshot(snapshot());
    await render(<AppView />); await authorize(); await click("Resume Goal");
    await act(async () => {
        if (event === "close") host.clients.at(-1)!.onclose!();
        if (event === "teardown") await host.clients.at(-1)!.onteardown!();
    });
    if (event === "unmount") await unmount();
    await act(async () => action.reject(new Error("old action transport failed")));
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/snapshot"))).toHaveLength(1);
    expect(container.textContent).not.toContain("old action transport failed");
    expect(container.textContent).not.toContain("Goal ctx-a"); expect(actions()).toHaveLength(1);
});

test("late interaction bootstrap cannot replace an explicitly authorized Context", async () => {
    const bootstrap = deferred<unknown>(); host.invoke = async () => bootstrap.promise; serveContexts();
    await render(<AppView view="interaction" />);
    expect(host.calls.map((call) => call.name)).toEqual(["mcpapp_open"]);
    await authorize("ctx-b", "beta");
    await act(async () => bootstrap.resolve({ _meta: { "portable-devshell/mcpapp": capability() } }));
    expect(container.textContent).toContain("Approval required");
    expect(vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes("/snapshot"))
        .map(([url]) => new URL(String(url)).searchParams.get("ctxId"))).toEqual(["ctx-b"]);
    await click("Approve"); expect(actions()[0]!.arguments.ctxId).toBe("ctx-b");
});

test("old Close failure and fullscreen result cannot modify a replacement Context", async () => {
    const close = deferred<void>(); const fullscreen = deferred<{ mode: string }>();
    host.teardownResult = close.promise; host.fullscreen = true; host.modeResult = fullscreen.promise;
    serveContexts(); await render(<AppView />); await authorize(); await click("Close");
    host.modeResult = undefined; host.acceptFullscreen = false; await authorize("ctx-b", "beta");
    await act(async () => { close.reject(new Error("old close failed")); fullscreen.resolve({ mode: "fullscreen" }); });
    expect(container.querySelector('[role="alert"]')).toBeNull(); expect(button("Close").disabled).toBe(false);
    expect(container.querySelector("main")!.getAttribute("data-display-mode")).toBe("inline");
    expect(container.textContent).toContain("Goal ctx-b");
});

test("automatic recovery cannot cross a Context capability switch", async () => {
    const pending = deferred<unknown>();
    host.invoke = async (call) => call.arguments.action === "claim" ? pending.promise : result({});
    const automatic = { ...snapshot(), reentry: { schedule: {
        readyAt: "2026-10-20T00:00:00Z", intent: "automatic" as const, sourceId: "goal-a",
    } } };
    serve((url, init) => url.pathname.endsWith("/snapshot")
        ? response(url.searchParams.get("ctxId") === "ctx-a" ? automatic : snapshot("ctx-b", "beta")) : hold(init?.signal));
    await render(<AppView />); await authorize(); expect(phases()).toEqual(["claim"]);
    await authorize("ctx-b", "beta"); await act(async () => pending.resolve(claim()));
    expect(phases()).toEqual(["claim", "release"]);
    expect(host.calls.map((call) => call.arguments.ctxId)).toEqual(["ctx-a", "ctx-a"]);
    expect(host.calls.map((call) => call.arguments.intent)).toEqual(["automatic", "automatic"]);
    expect(host.sent).toEqual([]); expect(host.contexts).toEqual([]);
});

test("a delayed A claim cannot deliver after A to B to A restoration with identical capability", async () => {
    const original = deferred<unknown>(); let claims = 0;
    host.invoke = async (call) => {
        if (call.arguments.action !== "claim") return result({ valid: true, attempted: true });
        return ++claims === 1 ? original.promise : result({ claimed: false });
    };
    serve((url, init) => url.pathname.endsWith("/snapshot")
        ? response(url.searchParams.get("ctxId") === "ctx-a" ? recovery() : snapshot("ctx-b", "beta")) : hold(init?.signal));
    await render(<AppView />); await authorize(); await authorize("ctx-b", "beta"); await authorize();
    expect(phases()).toEqual(["claim", "claim"]);
    await act(async () => original.resolve(claim()));
    expect(phases()).toEqual(["claim", "claim", "release"]);
    expect(host.calls[2]!.arguments.claimId).toBe(host.calls[0]!.arguments.claimId);
    expect(host.calls[1]!.arguments.claimId).not.toBe(host.calls[0]!.arguments.claimId);
    expect(host.sent).toEqual([]); expect(host.contexts).toEqual([]);
});

test("a final recovery refresh must still own its operation after a newer revision starts another claim", async () => {
    const oldRefresh = deferred<Response>(); const watch = deferred<Response>(); const claimPending = deferred<unknown>();
    let reads = 0; let watches = 0; let claims = 0;
    host.invoke = async (call) => {
        if (call.arguments.action !== "claim") return result({ valid: true, attempted: true });
        return ++claims === 1 ? result({ claimed: false }) : claimPending.promise;
    };
    let state = recovery();
    serve((url, init) => url.pathname.endsWith("/snapshot") ? ++reads === 2 ? oldRefresh.promise : response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize(); expect(reads).toBe(2);
    state = recovery(snapshot("ctx-a", "alpha", 12)); state.presentation.work[0]!.title = "Current claim revision 12";
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: state })));
    expect(phases()).toEqual(["claim", "claim"]);
    await act(async () => oldRefresh.resolve(response(snapshot("ctx-a", "alpha", 99))));
    expect(container.textContent).toContain("Current claim revision 12");
    await act(async () => claimPending.resolve(claim()));
    expect(phases()).toEqual(["claim", "claim", "validate", "attempt", "report"]);
    expect(host.sent).toHaveLength(1);
});

test("an uncertain attempt reports the original operation and never blindly replays on watch", async () => {
    const watch = deferred<Response>(); let watches = 0; let state = recovery();
    host.invoke = async (call) => {
        if (call.arguments.action === "claim") return claim();
        if (call.arguments.action === "attempt") throw new Error("attempt response lost");
        return result({ valid: true });
    };
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(host.calls.at(-1)!.arguments.outcome).toBe("uncertain");
    expect(host.sent).toEqual([]); expect(container.querySelector('[role="alert"]')!.textContent).toBe("attempt response lost");
    state = recovery(snapshot("ctx-a", "alpha", 12));
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: state })));
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(button("Resume Goal").disabled).toBe(false);
});

test("a superseded recovery error cannot overwrite a newer explicit action error", async () => {
    const context = deferred<unknown>(); host.contextResult = context.promise;
    host.invoke = async (call) => {
        if (call.name === "mcpapp_action") throw new Error("explicit action failed");
        return call.arguments.action === "claim" ? claim() : result({ valid: true });
    };
    serveSnapshot(recovery()); await render(<AppView />); await authorize(); await click("Resume Goal");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("explicit action failed");
    await act(async () => context.reject(new Error("obsolete recovery context failure")));
    expect(phases()).toEqual(["claim", "validate", "release"]);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("explicit action failed");
    expect(button("Resume Goal").disabled).toBe(false);
});

test("old watch authorization failure in the same turn as replacement cannot revoke the new session", async () => {
    const oldWatch = deferred<Response>();
    serve((url, init) => {
        const ctxId = url.searchParams.get("ctxId")!;
        if (url.pathname.endsWith("/snapshot")) return response(snapshot(ctxId));
        return ctxId === "ctx-a" ? oldWatch.promise : hold(init?.signal);
    });
    await render(<AppView />); await authorize();
    await act(async () => {
        host.clients.at(-1)!.ontoolresult!({ _meta: { "portable-devshell/mcpapp": capability("ctx-b", "beta") } });
        oldWatch.resolve(new Response("{}", { status: 401 }));
    });
    expect(container.textContent).toContain("Goal ctx-b");
    expect(container.textContent).not.toContain("authorization expired");
    await click("Resume Goal"); expect(actions()[0]!.arguments.ctxId).toBe("ctx-b");
});

test("Close remains available while a Context is announced but its private capability is pending", async () => {
    await render(<AppView />);
    await act(async () => host.clients.at(-1)!.ontoolinput!({ arguments: { ctxId: "ctx-pending" } }));
    expect(container.textContent).toContain("Context · ctx-pending");
    await click("Close"); expect(host.teardown).toBe(1); expect(button("Closing…").disabled).toBe(true);
    expect(host.calls).toEqual([]);
});

test("switching Host presentation reconnects observation under a fresh epoch with the same capability", async () => {
    serveSnapshot(snapshot()); await render(<AppView />); await authorize();
    expect(container.textContent).toContain("Goal ctx-a");
    await rerender(<AppView view="interaction" />);
    expect(host.clients).toHaveLength(2); expect(container.textContent).toContain("Approval required");
    await click("Approve"); expect(actions()[0]!.arguments.ctxId).toBe("ctx-a");
    expect(host.closed).toBe(1);
});

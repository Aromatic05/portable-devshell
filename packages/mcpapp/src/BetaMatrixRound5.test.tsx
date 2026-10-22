import { act } from "react";
import { expect, test, vi } from "vitest";
import {
    actions, authorize, button, capability, claim, click, container, deferred, hold, host,
    phases, recovery, render, response, result, serve, serveSnapshot, snapshot, unmount,
} from "./BetaMatrixRound5Harness.js";
import { AppView } from "./App.js";

test("round5: destroying Inline wait aborts observation without dispatching a tmux stop; audit restores independently", async () => {
    Object.assign(window, { openai: { toolResponseMetadata: { "portable-devshell/mcpapp": capability() } } });
    const state = snapshot();
    state.activity = [{ callId: "tmux-call", name: "tmux_run", taskId: "task-tmux-a", state: "completed",
        at: "2026-10-20T00:00:00Z", output: { task: { id: "task-tmux-a", status: "running" }, output: ["Build still running"] } }];
    const signals: AbortSignal[] = [];
    serve((url, init) => {
        if (url.pathname.endsWith("/snapshot")) return response(state);
        signals.push(init!.signal!); return hold(init?.signal);
    });
    await render(<AppView view="interaction" />);
    expect(container.textContent).toContain("Wait · active");
    expect(button("Approve").disabled).toBe(false);
    await unmount();
    expect(signals).toHaveLength(1); expect(signals[0]!.aborted).toBe(true);
    expect(host.closed).toBe(1); expect(host.sizeStopped).toBe(1);
    expect(host.calls).toEqual([]);
    await render(<AppView />); await click("Activity");
    await act(async () => { container.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container.querySelector(".tc-terminal pre")!.textContent).toContain("Build still running");
    expect(container.textContent).not.toContain("Approve");
    expect(host.calls).toEqual([]);
});

test("round5: approval transport failure preserves its message and enables retry while agent remains busy", async () => {
    Object.assign(window, { openai: { toolResponseMetadata: { "portable-devshell/mcpapp": capability() } } });
    serveSnapshot(snapshot());
    host.invoke = async () => { throw new Error("approval owner changed: claim-owner-b"); };
    await render(<AppView view="interaction" />); await click("Approve");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("approval owner changed: claim-owner-b");
    expect(button("Approve").disabled).toBe(false); expect(button("Deny").disabled).toBe(false);
    host.invoke = async () => result({ status: "applied" });
    await click("Deny");
    expect(actions().map((call) => call.arguments.actionId)).toEqual(["approve", "deny"]);
    expect(actions()[1]!.arguments.requestId).not.toBe(actions()[0]!.arguments.requestId);
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("round5: only the in-flight approval disables its actions; settling it restores both choices", async () => {
    Object.assign(window, { openai: { toolResponseMetadata: { "portable-devshell/mcpapp": capability() } } });
    const pending = deferred<unknown>(); host.invoke = async () => pending.promise; serveSnapshot(snapshot());
    await render(<AppView view="interaction" />);
    expect(button("Approve").disabled).toBe(false); expect(button("Deny").disabled).toBe(false);
    await click("Approve");
    expect(button("Applying…").disabled).toBe(true); expect(button("Deny").disabled).toBe(true);
    await click("Deny"); expect(actions()).toHaveLength(1);
    await act(async () => pending.resolve(result({ status: "applied" })));
    expect(button("Approve").disabled).toBe(false); expect(button("Deny").disabled).toBe(false);
    expect(actions()[0]!.arguments).toMatchObject({ ctxId: "ctx-a", itemId: "approval-a", actionId: "approve" });
    expect(host.modes).toEqual([]);
});

test("round5: Goal confirmation can be cancelled and Goal stale receipt requires dispatch with refreshed revision", async () => {
    let state = snapshot(); serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state) : hold(init?.signal));
    host.invoke = async () => { state = snapshot("ctx-a", "alpha", 20); return result({ status: "stale" }); };
    await render(<AppView />); await authorize(); await click("Pause Goal");
    expect(actions()).toHaveLength(0); await click("Back");
    expect(button("Pause Goal").disabled).toBe(false); expect(actions()).toHaveLength(0);
    await click("Resume Goal");
    expect(actions()[0]!.arguments).toMatchObject({ itemId: "goal-a", actionId: "goal-resume", expectedRevision: 13 });
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("review the latest status");
    await click("Resume Goal");
    expect(actions()).toHaveLength(2); expect(actions()[1]!.arguments.expectedRevision).toBe(22);
    await click("Pause Goal"); expect(actions()).toHaveLength(2); await click("Confirm Pause Goal");
    expect(actions()[2]!.arguments).toMatchObject({ itemId: "goal-a", actionId: "goal-pause", expectedRevision: 20 });
});

test("round5: late recovery claim after another Context restore releases old ownership without delivery", async () => {
    const pending = deferred<unknown>();
    host.invoke = async (call) => call.arguments.action === "claim" ? pending.promise : result({});
    serve((url, init) => url.pathname.endsWith("/snapshot")
        ? response(url.searchParams.get("ctxId") === "ctx-a" ? recovery() : snapshot("ctx-b", "beta")) : hold(init?.signal));
    await render(<AppView />); await authorize(); expect(phases()).toEqual(["claim"]);
    await act(async () => {
        Object.assign(window, { openai: { toolResponseMetadata: { "portable-devshell/mcpapp": capability("ctx-b", "beta") } } });
        window.dispatchEvent(new CustomEvent("openai:set_globals"));
    });
    await act(async () => pending.resolve(claim()));
    expect(phases()).toEqual(["claim", "release"]);
    expect(host.calls[1]!.arguments).toMatchObject({ ctxId: "ctx-a", directiveId: "directive-a", sourceId: "goal-a" });
    expect(host.calls[1]!.arguments.claimId).toBe(host.calls[0]!.arguments.claimId);
    expect(host.sent).toEqual([]); expect(host.contexts).toEqual([]);
    expect(container.textContent).toContain("Goal ctx-b"); expect(container.textContent).not.toContain("Goal ctx-a");
});

test("round5: recovery owner conflict does not deliver, release another owner, or disable explicit work actions", async () => {
    serveSnapshot(recovery()); host.invoke = async () => result({ claimed: false, owner: "other-host" });
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim"]); expect(host.sent).toEqual([]); expect(host.contexts).toEqual([]);
    expect(button("Resume Goal").disabled).toBe(false);
    expect(button("Pause Goal").disabled).toBe(false);
    await click("Resume Goal");
    expect(actions()).toHaveLength(1); expect(phases()).toEqual(["claim"]);
    expect(container.querySelector('[role="alert"]')).toBeNull();
});

test("round5: invalidated Goal recovery releases its exact claim before any Host context or send", async () => {
    serveSnapshot(recovery(snapshot(), "goal-resume"));
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: false });
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim", "validate", "release"]);
    expect(new Set(host.calls.map((call) => call.arguments.claimId)).size).toBe(1);
    expect(host.calls.map((call) => call.arguments.sourceId)).toEqual(["goal-a", "goal-a", "goal-a"]);
    expect(host.calls.map((call) => call.arguments.intent)).toEqual(["goal-resume", "goal-resume", "goal-resume"]);
    expect(host.sent).toEqual([]); expect(host.contexts).toEqual([]);
    expect(button("Resume Goal").disabled).toBe(false);
});

test("round5: Host context failure releases recovery and retains original error without attempted delivery", async () => {
    serveSnapshot(recovery()); host.contextError = new Error("host context quota exceeded");
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true });
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim", "validate", "release"]);
    expect(host.contexts).toHaveLength(1); expect(host.sent).toEqual([]);
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("host context quota exceeded");
    expect(button("Resume Goal").disabled).toBe(false);
});

test("round5: ambiguous Host send reports uncertain once and watch rerender does not replay recovery", async () => {
    const watch = deferred<Response>(); let watches = 0; const state = recovery();
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state)
        : watches++ === 0 ? watch.promise : hold(init?.signal));
    host.sendError = new Error("host send timed out after dispatch");
    host.invoke = async (call) => call.arguments.action === "claim" ? claim() : result({ valid: true, attempted: true });
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(host.calls.at(-1)!.arguments.outcome).toBe("uncertain");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("host send timed out after dispatch");
    await act(async () => watch.resolve(response({ changed: true, cursor: 12, snapshot: { ...state, cursor: 12 } })));
    expect(host.sent).toHaveLength(1); expect(host.contexts).toHaveLength(1);
    expect(phases()).toEqual(["claim", "validate", "attempt", "report"]);
    expect(button("Resume Goal").disabled).toBe(false);
});

test("round5: browser private-state hydration restores Activity after remount without reopening claimed fullscreen", async () => {
    host.fullscreen = true;
    const browser = { widgetState: { modelContent: { retained: true }, imageIds: ["image-keep"], privateContent: {
        portableDevshellMcpApp: capability(), portableDevshellFullscreenClaim: "ctx-a",
    } } };
    Object.assign(window, { openai: browser });
    const state = snapshot(); state.activity = [{ callId: "audit-a", name: "bash_run", state: "completed",
        at: "2026-10-20T00:00:00Z", target: "echo persisted" }];
    const reads: string[] = [];
    serve((url, init) => {
        if (url.pathname.endsWith("/snapshot")) return response(state);
        if (url.pathname.endsWith("/activity")) {
            reads.push(url.href);
            expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${capability().token}`);
            return response({ callId: "audit-a", stdout: "persisted after iframe destruction", stderr: "" });
        }
        return hold(init?.signal);
    });
    await render(<AppView />); await click("Activity");
    expect(reads).toEqual([]);
    await act(async () => { container.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container.querySelector(".tc-terminal pre")!.textContent).toContain("persisted after iframe destruction");
    await unmount(); await render(<AppView />); await click("Activity");
    expect(container.querySelector(".tc-terminal")).toBeNull();
    await act(async () => { container.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container.querySelector(".tc-terminal pre")!.textContent).toContain("persisted after iframe destruction");
    expect(reads).toHaveLength(2); expect(reads[1]).toBe(reads[0]); expect(host.modes).toEqual([]);
    expect(host.calls).toEqual([]); expect(container.textContent).not.toContain(capability().token);
});

test("round5: pending audited output is aborted on instance switch and cannot leak into the replacement Context", async () => {
    const output = deferred<Response>(); let outputSignal: AbortSignal | undefined;
    serve((url, init) => {
        const ctx = url.searchParams.get("ctxId")!;
        if (url.pathname.endsWith("/snapshot")) {
            const state = snapshot(ctx, ctx === "ctx-a" ? "alpha" : "beta");
            state.activity = [{ callId: "shared-call-id", name: "bash_run", state: "completed", at: "2026-10-20T00:00:00Z" }];
            return response(state);
        }
        if (url.pathname.endsWith("/activity")) { outputSignal = init!.signal!; return output.promise; }
        return hold(init?.signal);
    });
    await render(<AppView />); await authorize(); await click("Activity");
    await act(async () => { container.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(outputSignal!.aborted).toBe(false);
    await authorize("ctx-b", "beta"); expect(outputSignal!.aborted).toBe(true);
    await act(async () => output.resolve(response({ callId: "shared-call-id", stdout: "old private terminal", stderr: "" })));
    expect(container.textContent).toContain("beta"); expect(container.textContent).not.toContain("old private terminal");
    expect(container.querySelector(".tc-terminal")).toBeNull(); expect(host.calls).toEqual([]);
});

test("round5: mismatched Activity page is rejected and explicit retry starts at the same cursor without foreign output", async () => {
    const state = snapshot(); state.activity = [{ callId: "audit-a", name: "bash_run", state: "completed", at: "2026-10-20T00:00:00Z" }];
    const reads: string[] = [];
    serve((url, init) => {
        if (url.pathname.endsWith("/snapshot")) return response(state);
        if (url.pathname.endsWith("/activity")) {
            reads.push(url.href);
            return response(reads.length === 1
                ? { callId: "foreign-call", stdout: "foreign audit secret", stderr: "", nextSeq: 8 }
                : { callId: "audit-a", stdout: "authorized retained output", stderr: "" });
        }
        return hold(init?.signal);
    });
    await render(<AppView />); await authorize(); await click("Activity");
    await act(async () => { container.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container.textContent).toContain("Invalid MCP App Activity output");
    expect(container.textContent).not.toContain("foreign audit secret"); expect(button("Retry output").disabled).toBe(false);
    await click("Retry output");
    expect(reads).toHaveLength(2); expect(reads[0]).toBe(reads[1]); expect(reads[1]).toContain("fromSeq=1");
    expect(container.querySelector(".tc-terminal pre")!.textContent).toContain("authorized retained output");
    expect(container.textContent).not.toContain("Invalid MCP App Activity output"); expect(host.calls).toEqual([]);
});

test("round5: refused fullscreen does not loop and failed Close permits explicit retry without workspace actions", async () => {
    host.fullscreen = true; host.acceptFullscreen = false; serveSnapshot(snapshot());
    await render(<AppView />); await authorize(); expect(host.modes).toEqual(["fullscreen"]);
    await click("Tasks"); await click("Overview"); expect(host.modes).toEqual(["fullscreen"]);
    await click("Open fullscreen"); expect(host.modes).toEqual(["fullscreen", "fullscreen"]);
    host.teardownError = new Error("Host cannot close this surface"); await click("Close");
    expect(container.querySelector('[role="alert"]')!.textContent).toBe("Host cannot close this surface");
    expect(button("Close").disabled).toBe(false);
    host.teardownError = undefined; await click("Close"); expect(button("Closing…").disabled).toBe(true);
    expect(host.teardown).toBe(2); expect(host.calls).toEqual([]);
});

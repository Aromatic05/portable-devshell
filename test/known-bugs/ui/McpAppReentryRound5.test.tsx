import { act } from "react";
import { expect, test } from "vitest";
import {
    authorize, capability, claim, container, deferred, hold, host, phases,
    recovery, render, response, result, serve, snapshot,
} from "../../../packages/mcpapp/src/BetaMatrixRound5Harness.js";
import { AppView } from "../../../packages/mcpapp/src/App.js";

test("RED: Host capability switch must not claim old Context directive under replacement Context", async () => {
    const pending = deferred<unknown>();
    host.invoke = async (call) => call.arguments.action === "claim" ? pending.promise : result({});
    serve((url, init) => url.pathname.endsWith("/snapshot")
        ? response(url.searchParams.get("ctxId") === "ctx-a" ? recovery() : snapshot("ctx-b", "beta")) : hold(init?.signal));
    await render(<AppView />); await authorize();
    expect(phases()).toEqual(["claim"]);
    await authorize("ctx-b", "beta");
    await act(async () => pending.resolve(claim()));
    // ctx-b has no recovery directive. Only ctx-a may claim/release directive-a.
    expect(host.calls.filter((call) => call.name === "mcpapp_reentry").map((call) => ({
        ctxId: call.arguments.ctxId, action: call.arguments.action,
    }))).toEqual([{ ctxId: "ctx-a", action: "claim" }, { ctxId: "ctx-a", action: "release" }]);
    expect(host.sent).toEqual([]);
});

test("RED: recovery final refresh started before Context restore must not replace new Context after await", async () => {
    const oldRefresh = deferred<Response>(); let readsA = 0;
    host.invoke = async () => result({ claimed: false });
    serve((url, init) => {
        if (!url.pathname.endsWith("/snapshot")) return hold(init?.signal);
        if (url.searchParams.get("ctxId") === "ctx-b") return response(snapshot("ctx-b", "beta"));
        return ++readsA === 1 ? response(recovery()) : oldRefresh.promise;
    });
    await render(<AppView />); await authorize(); expect(readsA).toBe(2);
    await act(async () => {
        Object.assign(window, { openai: { toolResponseMetadata: { "portable-devshell/mcpapp": capability("ctx-b", "beta") } } });
        window.dispatchEvent(new CustomEvent("openai:set_globals"));
    });
    expect(container.textContent).toContain("Goal ctx-b");
    await act(async () => oldRefresh.resolve(response(snapshot())));
    expect(container.textContent).toContain("Goal ctx-b");
    expect(container.textContent).not.toContain("Goal ctx-a");
});

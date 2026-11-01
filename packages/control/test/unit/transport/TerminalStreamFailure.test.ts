import assert from "node:assert/strict";
import test from "node:test";
import { createPortClient, createTerminalTransport, routeModule } from "@portable-devshell/shared";
import { TerminalSessionService } from "../../../../core/src/terminal/Service.ts";
import { createTerminalRouteModule } from "../../../../core/src/terminal/Route.ts";
import type { TerminalProcess } from "../../../../core/src/terminal/Api.ts";
import { workerSessionTransport } from "../../support/WorkerSessionTransport.ts";

test("stale terminal input cancels its attachment while Control RPC, PTY and another attachment survive", { timeout: 5000 }, async (t) => {
    const inputs: string[] = [];
    const outputs = new Set<(data: string) => void>();
    let killed = false, disposed = false;
    const process: TerminalProcess = {
        write: (data) => { inputs.push(data); },
        resize: () => undefined,
        kill: () => { killed = true; },
        dispose: () => { disposed = true; },
        onData: (listener) => { outputs.add(listener); return () => { outputs.delete(listener); }; },
        onExit: () => () => undefined,
    };
    const backend = { open: async () => process };
    const sessions = new TerminalSessionService({ idFactory: () => "shared-terminal" });
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<string>((resolve) => { release = () => resolve("survived"); });
    const { endpoint } = await workerSessionTransport(t, [], () => [{
        host: "alpha",
        ports: [
            createTerminalRouteModule({ backend, instance: "alpha", sessions }),
            routeModule("sibling", { wait: () => { entered(); return pending; }, echo: () => "healthy" }),
        ],
    }]);
    const terminal = createTerminalTransport(endpoint, "alpha");
    const opened = await terminal.open({ cols: 80, rows: 24, workspace: "/workspace" });
    const identity = { terminalId: opened.terminalId, generation: opened.generation };
    const stale = await terminal.attach({ ...identity, fromSeq: 0 });
    const healthy = await terminal.attach({ ...identity, fromSeq: 0 });
    t.after(() => { stale.close(); healthy.close(); release(); });
    assert.equal((await stale.next()).kind, "seed");
    assert.equal((await healthy.next()).kind, "seed");
    const sibling = createPortClient(endpoint, "alpha", "sibling");
    const unrelated = sibling.request("wait");
    await started;
    await healthy.sendResize(100, 40, { ...identity, version: opened.version, clientSeq: 1 });
    const resized = await healthy.next();
    assert.equal(resized.kind, "resized");
    if (resized.kind !== "resized") assert.fail("expected resized acknowledgement");
    await stale.sendInput("stale", { ...identity, version: opened.version, clientSeq: 1 });
    const closed = await stale.next();
    assert.equal(closed.kind, "closed");
    if (closed.kind !== "closed") assert.fail("expected stream cancellation");
    assert.match(closed.error?.message ?? "", /version/i);
    release();
    assert.equal(await unrelated, "survived");
    assert.equal(await sibling.request("echo"), "healthy");
    await healthy.sendInput("accepted", { ...resized.identity, clientSeq: 2 });
    assert.equal((await healthy.next()).kind, "inputAccepted");
    for (const emit of outputs) emit("still running");
    assert.deepEqual(await healthy.next(), { kind: "output", frame: { data: "still running", seq: 1 } });
    assert.deepEqual(inputs, ["accepted"]);
    assert.equal(sessions.get(opened.terminalId).state, "running");
    assert.equal(killed, false);
    assert.equal(disposed, false);
    assert.equal(endpoint.connected, true);
});

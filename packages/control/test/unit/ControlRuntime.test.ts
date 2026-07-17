import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlRuntime } from "../../dist/testing.js";

test("runtime stop does not settle until owned cleanup completes", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-stop-"));
    const socketPath = join(runtimeDir, "control.sock");
    let releaseArtifact!: () => void;
    const artifactGate = new Promise<void>((resolve) => {
        releaseArtifact = resolve;
    });
    let artifactStopping = false;
    const runtime = new ControlRuntime({
        artifact: {
            service: undefined,
            async stop() {
                artifactStopping = true;
                await artifactGate;
            }
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {}
        } as never,
        mcp: {
            configEditor: undefined,
            instanceCreate: undefined,
            oauthApprovals: () => undefined,
            async start() {},
            status: () => ({ running: false }),
            async stop() {}
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {}
        } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        releaseArtifact();
        await runtime.stop().catch(() => undefined);
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    let settled = false;
    const stopping = runtime.stop().finally(() => {
        settled = true;
    });
    await waitFor(() => artifactStopping);

    assert.equal(settled, false);

    releaseArtifact();
    await stopping;
    await assert.rejects(access(socketPath));
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Timed out waiting for condition.");
}

test("runtime stop attempts every cleanup step after failures", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-runtime-failure-"));
    const socketPath = join(runtimeDir, "control.sock");
    const calls: string[] = [];
    const runtime = new ControlRuntime({
        artifact: {
            service: undefined,
            async stop() {
                calls.push("artifact");
                throw new Error("artifact stop failed");
            }
        } as never,
        instances: {
            list: () => [],
            onChange: () => () => undefined,
            async stopOwned() {
                calls.push("instances");
                throw new Error("instance stop failed");
            }
        } as never,
        mcp: {
            configEditor: undefined,
            instanceCreate: undefined,
            oauthApprovals: () => undefined,
            async start() {},
            status: () => ({ running: false }),
            async stop() {
                calls.push("mcp");
                throw new Error("mcp stop failed");
            }
        } as never,
        restart: async () => undefined,
        reverse: {
            service: undefined,
            stop() {
                calls.push("reverse");
                throw new Error("reverse stop failed");
            }
        } as never,
        shutdown: async () => undefined,
        socketPath
    });
    t.after(async () => {
        await rm(runtimeDir, { force: true, recursive: true });
    });

    await runtime.start();
    await assert.rejects(runtime.stop(), AggregateError);

    assert.deepEqual(calls, ["reverse", "mcp", "artifact", "instances"]);
    await assert.rejects(access(socketPath));
});

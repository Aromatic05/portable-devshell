import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlServer } from "../../src/server/ControlServer.ts";

test("concurrent restart then shutdown preserves lifecycle request order", async (t) => {
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-server-"));
    t.after(async () => {
        await rm(xdgRuntimeDir, { force: true, recursive: true });
    });
    const events: string[] = [];
    let releaseFirstStop!: () => void;
    const firstStopGate = new Promise<void>((resolve) => {
        releaseFirstStop = resolve;
    });
    let controls: { restart(): Promise<void>; shutdown(): Promise<void> } | undefined;
    let runtimeNumber = 0;
    const server = new ControlServer({
        configStore: {
            async readOrCreate() {
                return {};
            }
        } as never,
        instanceRegistryBuilder: {
            build() {
                return {};
            }
        } as never,
        runtimeFactory: {
            async create(options: { restart(): Promise<void>; shutdown(): Promise<void> }) {
                controls ??= options;
                runtimeNumber += 1;
                const current = runtimeNumber;
                return {
                    async start() {
                        events.push(`start-${current}`);
                    },
                    async stop() {
                        events.push(`stop-${current}`);
                        if (current === 1) {
                            await firstStopGate;
                        }
                    }
                };
            }
        } as never,
        xdgRuntimeDir
    });

    await server.start();
    const restarting = controls!.restart();
    await waitFor(() => events.includes("stop-1"));
    const shuttingDown = controls!.shutdown();
    releaseFirstStop();

    await Promise.all([restarting, shuttingDown]);

    assert.deepEqual(events, ["start-1", "stop-1", "start-2", "stop-2"]);
});

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}

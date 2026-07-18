import assert from "node:assert/strict";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

import { TuiAppStore } from "../../src/testing.ts";
import { TuiRuntimeAttachOperations } from "../../src/runtime/operation/TuiRuntimeAttachOperations.ts";

test("attach operation reports an unavailable selected instance without invoking control", async () => {
    const harness = createHarness();

    await harness.operations.attachShell("missing");

    assert.deepEqual(harness.calls, []);
    assert.equal(
        harness.store.getState().interaction.screenStatusByPage.instances,
        "Attach Shell failed: selected entry is unavailable."
    );
});

test("attach operation reports resolver failures before suspending the TUI", async () => {
    const harness = createHarness();
    harness.store.replaceInstances([
        {
            defaultWorkspace: "/workspace/alpha",
            enabled: true,
            mcpEnabled: false,
            name: "alpha",
            provider: "docker"
        }
    ]);
    harness.store.setConfigView({
        instances: [
            {
                container: { containerName: "alpha", mode: "preset" },
                name: "alpha",
                provider: "docker"
            }
        ]
    } as never);
    harness.store.replaceSnapshot({
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 0,
        name: asInstanceName("alpha"),
        ready: false,
        status: "stopped"
    });

    await harness.operations.attachShell("alpha");

    assert.deepEqual(harness.calls, []);
    assert.equal(
        harness.store.getState().interaction.screenStatusByPage.instances,
        "Attach Shell failed: Container is not running. Use Start Worker first."
    );
});

test(
    "attach operation restores the TUI and refreshes control state after a local shell exits",
    { skip: process.platform === "win32" },
    async (context) => {
        const previousShell = process.env.SHELL;
        process.env.SHELL = "/bin/true";
        context.after(() => {
            if (previousShell === undefined) {
                delete process.env.SHELL;
            } else {
                process.env.SHELL = previousShell;
            }
        });

        const harness = createHarness();
        harness.store.replaceInstances([
            {
                defaultWorkspace: process.cwd(),
                enabled: true,
                mcpEnabled: false,
                name: "alpha",
                provider: "local"
            }
        ]);

        await harness.operations.attachShell("alpha");

        assert.deepEqual(harness.calls, [
            "suspend",
            "resume",
            "runtime.refresh:alpha",
            "session.refresh:alpha"
        ]);
        assert.equal(harness.store.getState().snapshotsByInstance.alpha?.status, "ready");
        assert.equal(
            harness.store.getState().interaction.screenStatusByPage.instances,
            "Shell exited. Status refreshed from control."
        );
    }
);

function createHarness() {
    const calls: string[] = [];
    const store = new TuiAppStore();
    const operations = new TuiRuntimeAttachOperations({
        attachHooks: {
            resume() {
                calls.push("resume");
            },
            suspend() {
                calls.push("suspend");
            }
        },
        clients: {
            runtime: {
                async refresh(instance: string) {
                    calls.push(`runtime.refresh:${instance}`);
                    return {
                        snapshot: {
                            connectionState: "connected",
                            daemonState: "running",
                            lastSeq: 1,
                            name: instance,
                            ready: true,
                            status: "ready"
                        }
                    };
                }
            }
        } as never,
        session: {
            async refreshInstance(instance: string) {
                calls.push(`session.refresh:${instance}`);
            }
        } as never,
        store
    });

    return { calls, operations, store };
}

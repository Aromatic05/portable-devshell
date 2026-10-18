import assert from "node:assert/strict";
import test from "node:test";

import { executeInstanceLifecycle } from "../../src/command/instance/lifecycle/Command.js";

test("instance list uses Instance runtime snapshots rather than Control placeholders", async () => {
    const queried: string[] = [];
    let text = "";
    let records: readonly unknown[] = [];
    const stopped = { name: "local", status: "stopped", ready: false };
    const entries = [
        { name: "local", enabled: true, mcpEnabled: true, snapshot: stopped },
        { name: "reverse", enabled: true, mcpEnabled: true,
            snapshot: { name: "reverse", status: "stopped", ready: false } },
        { name: "disabled", enabled: false, mcpEnabled: false,
            snapshot: { name: "disabled", status: "stopped", ready: false } },
    ];
    await executeInstanceLifecycle({ kind: "instance.list" }, {
        clients: {
            instance: { listInstances: async () => entries },
            runtime(name: string) {
                queried.push(name);
                return { snapshot: async () => ({
                    snapshot: { name, status: "ready", ready: true },
                }) };
            },
        },
        writeRecords(value: readonly unknown[], rendered: string) {
            records = value;
            text = rendered;
        },
    } as never);

    assert.deepEqual(queried.sort(), ["local", "reverse"]);
    assert.equal(text, "local\tready\tready=true\nreverse\tready\tready=true\ndisabled\tstopped\tready=false\n");
    assert.deepEqual(records.map((entry) => (entry as { snapshot: { status: string } }).snapshot.status),
        ["ready", "ready", "stopped"]);
    assert.equal(entries[0].snapshot, stopped, "Control configuration result is not mutated");
});

test("instance list does not conceal an unreachable runtime as stopped", async () => {
    let rendered = false;
    await assert.rejects(executeInstanceLifecycle({ kind: "instance.list" }, {
        clients: {
            instance: { listInstances: async () => [
                { name: "local", enabled: true, snapshot: { status: "stopped", ready: false } },
            ] },
            runtime: () => ({ snapshot: async () => { throw new Error("Instance unreachable"); } }),
        },
        writeRecords: () => { rendered = true; },
    } as never), /Instance unreachable/u);
    assert.equal(rendered, false);
});

test("instance cleanup CLI parses read-only listing and explicit named retry", async () => {
    const { parseInstanceCommand } = await import("../../src/command/instance/Parse.js");
    assert.deepEqual(parseInstanceCommand(["cleanup", "list"]), {
        kind: "instance.cleanup.list",
    });
    assert.deepEqual(parseInstanceCommand(["cleanup", "retry", "old-host"]), {
        kind: "instance.cleanup.retry",
        instance: "old-host",
    });
    assert.throws(() => parseInstanceCommand(["cleanup", "retry"]), /cleanup/u);

    const received: unknown[] = [];
    const calls: string[] = [];
    const debts = [{
        instance: "old-host",
        generationId: "prior-generation",
        state: "orphaned",
        guidance: "Inspect the old remote resource manually.",
    }];
    const context = {
        clients: { instance: {
            async listCleanupDebts() { calls.push("list"); return debts; },
            async retryCleanupDebt(name: string) { calls.push("retry:" + name); return debts; },
        } },
        writeJson(value: unknown) { received.push(value); },
    };
    await executeInstanceLifecycle({ kind: "instance.cleanup.list" }, context as never);
    await executeInstanceLifecycle({
        kind: "instance.cleanup.retry", instance: "old-host",
    }, context as never);
    assert.deepEqual(calls, ["list", "retry:old-host"]);
    assert.deepEqual(received, [debts, debts]);
});

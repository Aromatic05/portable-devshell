import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { assertTestspaceExecutionContext } from "./TestspaceNamespace.mjs";
import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

export function assertRetiredInstance({ result, debts, name }) {
    assert.equal(result?.cleanupPending, false,
        "Instance deletion left worker retirement pending: " + JSON.stringify({ result, debts }));
    assert.equal(debts.some((entry) => entry.instance === name && entry.state === "pending"), false,
        "Deleted instance retained a pending generation debt: " + JSON.stringify(debts));
}

export async function runTestspaceRetirementSmoke({ runtimeDirectory }) {
    const root = process.env.DEVSHELL_TESTSPACE_ROOT;
    assertTestspaceExecutionContext(root, process.env);
    const name = "qa-retire-" + randomUUID().slice(0, 8);
    const draft = { name, provider: "local", enabled: true, mcp: { enabled: false } };
    const configPath = join(root, "home", ".devshell", "control", "instances", name + ".toml");
    const control = (operation) =>
        withTestspaceControlConnection(runtimeDirectory, (shared, endpoint) => operation(shared, endpoint));
    const instances = (operation) =>
        control((shared, endpoint) => operation(shared.createInstanceTransport(endpoint)));
    const worker = (operation) =>
        control((shared, endpoint) => operation(shared.createProcessTransport(endpoint, name)));
    const baseline = (await instances((client) => client.listInstances())).map((entry) => entry.name).sort();
    const phases = [];
    let exists = false;
    async function create() {
        await instances((client) => client.createInstance(draft));
        exists = true;
        assert.ok((await instances((client) => client.listInstances())).some((entry) => entry.name === name));
        assert.match(await readFile(configPath, "utf8"), /provider = "local"/u);
    }
    async function deleteAndVerify(phase) {
        const result = await instances((client) => client.deleteInstance(name));
        exists = false;
        const debts = await instances((client) => client.listCleanupDebts());
        process.stdout.write("[retirement-smoke] " + phase + " " + JSON.stringify({ result, debts }) + "\n");
        assertRetiredInstance({ result, debts, name });
        await assert.rejects(readFile(configPath), { code: "ENOENT" });
        phases.push(phase);
    }
    async function startAndStop() {
        const started = await worker(async (client) => {
            const operation = await client.start();
            return await operation.snapshot;
        });
        assert.equal(started.ready, true, "Worker startup must actually finish");
        const stopped = await worker((client) => client.stop());
        assert.equal(stopped.ready, false, "Stopped Worker cannot be reported ready");
    }
    async function waitForRestartedControl() {
        let latest;
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
            try {
                latest = await instances((client) => client.listInstances());
                if (latest.some((entry) => entry.name === name)) return;
            } catch (error) {
                latest = { error: String(error) };
            }
            await new Promise((resolve) => setTimeout(resolve, 80));
        }
        assert.fail("Control did not restore the disposable instance: " + JSON.stringify(latest));
    }

    try {
        await create();
        await deleteAndVerify("never-started");

        await create();
        await startAndStop();
        await deleteAndVerify("stopped-worker");

        await create();
        const started = await worker(async (client) => {
            const operation = await client.start();
            return await operation.snapshot;
        });
        assert.equal(started.ready, true);
        await control(async (shared, endpoint) => {
            const current = await shared.createInstanceTransport(endpoint).snapshotInstances();
            assert.ok(current.instances.some((entry) => entry.name === name));
            const outcome = await shared.createServerTransport(endpoint, { clientKind: "cli" }).restart();
            assert.equal(outcome.accepted, true);
        });
        await waitForRestartedControl();
        // Explicitly stop a Worker adopted by the new Control lifetime.
        const stopped = await worker((client) => client.stop());
        assert.equal(stopped.ready, false);
        await deleteAndVerify("control-restart-then-stop");

        assert.deepEqual((await instances((client) => client.listInstances())).map((entry) => entry.name).sort(), baseline);
        return { phases, workerStoppedBeforeRetirement: true, controlRestart: true, nameReusable: true };
    } finally {
        if (exists) {
            // No silent deletion retries: preserve a failing cleanup diagnosis.
            const cleanup = await instances((client) => client.deleteInstance(name));
            if (cleanup.cleanupPending)
                process.stderr.write("[retirement-smoke] cleanupPending after error: " + JSON.stringify(cleanup) + "\n");
        }
    }
}

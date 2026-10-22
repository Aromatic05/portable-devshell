import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { assertTestspaceExecutionContext } from "./TestspaceNamespace.mjs";
import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

// Do not run this against a shared Testspace: it deliberately restarts Control.
// Each wait has a deadline; polling is only used for actual startup convergence.
export async function recoveryDeadline(operation, label, timeoutMs = 30_000) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`Recovery smoke timed out: ${label}`)), timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

export function assertRecoveryAudit(before, after) {
    assert.ok(before.length >= 2, "Audit baseline must contain successful and nonzero shell calls");
    assert.equal(new Set(before.map((call) => call.callId)).size, before.length);
    assert.equal(new Set(after.map((call) => call.callId)).size, after.length, "Duplicate audit call IDs after recovery");
    assert.equal(after.length, before.length, "Recovery lost or duplicated an audited call");
    const ordered = (calls) => [...calls].sort((a, b) => a.callId.localeCompare(b.callId));
    assert.deepEqual(ordered(after), ordered(before), "Recovery changed persisted audit records, input or output");
}

export function assertRecoveryEvent(message, revision) {
    assert.equal(message.kind, "event", JSON.stringify(message));
    assert.equal(message.event.kind, "config");
    assert.equal(message.event.revision, revision, "Instance stream skipped, duplicated or reordered a revision");
}

export async function runTestspaceRecoverySmoke({ endpoint, runtimeDirectory, workspace }) {
    const root = process.env.DEVSHELL_TESTSPACE_ROOT;
    assertTestspaceExecutionContext(root, process.env);
    const name = `qa-recovery-${randomUUID().slice(0, 8)}`;
    const draft = {
        name, provider: "local", enabled: false,
        mcp: { enabled: true, auth: "none", contextMode: "explicit", path: `/${name}/mcp` },
        security: { mode: "workspace" }, approvalPolicy: { mode: "allow" },
    };
    const configPath = join(root, "home", ".devshell", "control", "instances", `${name}.toml`);
    const target = new URL(endpoint);
    target.pathname = `/${name}/mcp`;
    const control = (operation) => withTestspaceControlConnection(runtimeDirectory, operation);
    const instances = (operation) => control((shared, connection) => operation(shared.createInstanceTransport(connection)));
    const log = (phase) => process.stdout.write(`[recovery-smoke] ${phase}\n`);
    let client;
    let created = false;
    const connectMcp = async () => {
        const next = new Client({ name: "testspace-recovery-smoke", version: "0.0.0" },
            { versionNegotiation: { mode: "auto" } });
        client = next;
        await next.connect(new StreamableHTTPClientTransport(target));
    };
    const call = async (toolName, args) => {
        const result = await client.callTool({ name: toolName, arguments: args });
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.ok(result.structuredContent, `${toolName} omitted structured content`);
        return result.structuredContent;
    };
    const waitForInstance = async () => {
        const until = Date.now() + 30_000;
        let last;
        while (Date.now() < until) {
            try {
                last = await control(async (shared, connection) => ({
                    status: await shared.createServerTransport(connection, { clientKind: "cli" }).status(),
                    ...await shared.createProcessTransport(connection, name).snapshot(),
                }));
            } catch (error) {
                // Only transport unavailability during a requested restart is retried.
                last = { error: String(error) };
            }
            if (last.status?.ready === true && last.snapshot?.name === name) return last.snapshot;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.fail(`Instance did not reappear after Control restart: ${JSON.stringify(last)}`);
    };
    const startWorker = () => control(async (shared, connection) => {
        const started = await shared.createProcessTransport(connection, name).start();
        assert.equal((await recoveryDeadline(started.snapshot, "start dedicated Worker")).ready, true);
    });
    try {
        const baseline = (await instances((transport) => transport.listInstances())).map((entry) => entry.name).sort();
        await instances((transport) => transport.createInstance(draft));
        created = true;
        log("real IPC stream cancellation, replay, overflow and snapshot recovery");
        const streamResult = await control(async (shared, connection) => {
            const transport = shared.createInstanceTransport(connection);
            const snapshot = await transport.snapshotInstances();
            const from = snapshot.revision + 1;
            const cancelled = await transport.subscribeInstances(from);
            const pending = cancelled.next();
            cancelled.close();
            assert.equal((await recoveryDeadline(pending, "cancel pending stream read")).kind, "closed");
            const stream = await transport.subscribeInstances(from);
            try {
                await transport.updateInstance({ instanceName: name, patch: { env: { RECOVERY_REVISION: "0" } } });
                assertRecoveryEvent(await recoveryDeadline(stream.next(), "first live revision"), from);
            } finally {
                stream.close();
            }
            // A genuinely disconnected client misses commits; reconnect on a new
            // Endpoint and require the retained seed to contain every revision.
            return { from };
        });
        const firstRevision = streamResult.from;
        for (let index = 1; index <= 3; index += 1)
            await instances((transport) => transport.updateInstance({ instanceName: name,
                patch: { env: { RECOVERY_REVISION: String(index) } } }));
        await control(async (shared, connection) => {
            const transport = shared.createInstanceTransport(connection);
            const replay = await transport.subscribeInstances(firstRevision + 1);
            try {
                for (let offset = 1; offset <= 3; offset += 1)
                    assertRecoveryEvent(await recoveryDeadline(replay.next(), "reconnected seed"), firstRevision + offset);
            } finally {
                replay.close();
            }
            // InstanceChangeHub retains 256 revisions. Real persisted Config
            // commits exceed that boundary without a fake producer or sleeps.
            for (let index = 4; index <= 260; index += 1)
                await transport.updateInstance({ instanceName: name,
                    patch: { env: { RECOVERY_REVISION: String(index) } } });
            const gapStream = await transport.subscribeInstances(firstRevision);
            try {
                const gap = await recoveryDeadline(gapStream.next(), "bounded history gap");
                assert.equal(gap.kind, "gap");
                assert.equal(gap.gap.fromSeq, firstRevision);
                assert.equal(gap.gap.nextSeq, firstRevision + 5);
                assert.equal(gap.gap.lastSeq, firstRevision + 260);
            } finally {
                gapStream.close();
            }
            const refreshed = await transport.snapshotInstances();
            assert.equal(refreshed.revision, firstRevision + 260);
            assert.equal(refreshed.instances.find((entry) => entry.name === name)?.enabled, false);
            const resumed = await transport.subscribeInstances(refreshed.revision + 1);
            try {
                await transport.updateInstance({ instanceName: name, patch: { env: { RECOVERY_REVISION: "recovered" } } });
                assertRecoveryEvent(await recoveryDeadline(resumed.next(), "event after gap recovery"), refreshed.revision + 1);
            } finally {
                resumed.close();
            }
        });
        log("enable dedicated Worker; record real MCP shell results and durable Goal");
        await instances((transport) => transport.enableInstance(name));
        await startWorker();
        await connectMcp();
        const environment = await call("environ_info", { workspace });
        const ctxId = environment.ctxId;
        assert.equal(typeof ctxId, "string");
        const marker = `audit-${randomUUID()}`;
        for (const exitCode of [0, 7]) {
            const result = await call("bash_run", { ctxId, timeoutMs: 10_000,
                command: `printf '${marker}-${exitCode}'; printf '${marker}-stderr' >&2; exit ${exitCode}` });
            assert.equal(result.exitCode, exitCode);
            assert.equal(result.stdout, `${marker}-${exitCode}`);
            assert.equal(result.stderr, `${marker}-stderr`);
        }
        const objective = `Verify durable Goal and audit recovery ${marker}`;
        const startedGoal = await call("workspace_goal", { ctxId, action: "start", objective });
        assert.equal(startedGoal.goal.status, "active");
        const updatedGoal = await call("workspace_goal", { ctxId, action: "update",
            expectedGoalId: startedGoal.goal.goalId, expectedRevision: startedGoal.goal.revision,
            note: "Verify durable state and audit across Worker and Control restart." });
        assert.ok(updatedGoal.goal.revision > startedGoal.goal.revision);
        const readGoal = () => control((shared, connection) =>
            shared.createTaskTransport(connection, name).getGoal(ctxId));
        const beforeGoal = (await readGoal()).goal;
        assert.deepEqual(beforeGoal, updatedGoal.goal);
        assert.equal(beforeGoal.objective, objective);
        const query = { ctxId, toolName: "bash_run", includeInput: true, includeOutput: true, limit: 100 };
        const readAudit = () => control((shared, connection) => shared.createToolTransport(connection, name).listCalls(query));
        const beforeAudit = await readAudit();
        assert.equal(beforeAudit.length, 2);
        assert.deepEqual(beforeAudit.map((entry) => entry.exitCode).sort((a, b) => a - b), [0, 7]);
        for (const entry of beforeAudit) {
            assert.equal(entry.status, "completed");
            assert.equal(entry.source, "mcp");
            assert.ok(entry.input, "Audit query must include persisted input");
            assert.ok(entry.output, "Audit query must include persisted output");
        }
        const readLogs = () => control(async (shared, connection) => {
            const transport = shared.createProcessTransport(connection, name);
            const logs = [];
            for (const entry of beforeAudit)
                logs.push(...await transport.readLogs({ callId: entry.callId, ctxId, limit: 100 }));
            return logs.sort((a, b) => a.seq - b.seq);
        });
        const beforeLogs = await readLogs();
        for (const entry of beforeAudit) {
            const logs = beforeLogs.filter((log) => log.callId === entry.callId);
            assert.equal(logs.filter((log) => log.stream === "stdout").map((log) => log.message).join(""), `${marker}-${entry.exitCode}`);
            assert.equal(logs.filter((log) => log.stream === "stderr").map((log) => log.message).join(""), `${marker}-stderr`);
        }
        await client.close();
        client = undefined;
        log("stop/start dedicated Worker and reconnect with a fresh MCP session");
        await control(async (shared, connection) => {
            const transport = shared.createProcessTransport(connection, name);
            const stopped = await transport.stop();
            assert.equal(stopped.ready, false);
            const started = await transport.start();
            assert.equal((await recoveryDeadline(started.snapshot, "Worker restart")).ready, true);
        });
        assertRecoveryAudit(beforeAudit, await readAudit());
        assert.deepEqual(await readLogs(), beforeLogs, "Recovery lost or changed audited shell output");
        assert.deepEqual((await readGoal()).goal, beforeGoal);
        await connectMcp();
        assert.equal(typeof (await call("environ_info", { workspace })).ctxId, "string");
        await client.close();
        client = undefined;
        log("restart Control over guarded IPC; observe stream fault before reconnect");
        await control(async (shared, connection) => {
            const transport = shared.createInstanceTransport(connection);
            const snapshot = await transport.snapshotInstances();
            const stream = await transport.subscribeInstances(snapshot.revision + 1);
            try {
                const closed = stream.next();
                assert.equal((await shared.createServerTransport(connection, { clientKind: "cli" }).restart()).accepted, true);
                assert.equal((await recoveryDeadline(closed, "Control disconnect")).kind, "closed");
            } finally {
                stream.close();
            }
        });
        await waitForInstance();
        // Explicit process ownership is released by Control.close(); the new
        // lifetime must start its Worker before admitting fresh MCP work.
        await startWorker();
        assertRecoveryAudit(beforeAudit, await readAudit());
        assert.deepEqual(await readLogs(), beforeLogs, "Recovery lost or changed audited shell output");
        assert.deepEqual((await readGoal()).goal, beforeGoal);
        assert.match(await readFile(configPath, "utf8"), /RECOVERY_REVISION = "recovered"/u);
        await connectMcp();
        const freshContext = await call("environ_info", { workspace });
        const after = await call("bash_run", { ctxId: freshContext.ctxId, command: `printf '${marker}-after'`, timeoutMs: 10_000 });
        assert.equal(after.exitCode, 0);
        assert.equal(after.stdout, `${marker}-after`);
        await client.close();
        client = undefined;
        log("delete, verify cleanup debt and config removal, then reuse the same name");
        const deletion = await instances((transport) => transport.deleteInstance(name));
        log("committed delete outcome: " + JSON.stringify(deletion));
        if (deletion.cleanupPending) {
            const debts = await instances((transport) => transport.listCleanupDebts());
            log("committed delete cleanup debt: " + JSON.stringify(debts.filter((entry) => entry.instance === name)));
        }
        if (deletion.cleanupPending) {
            // Commit must remain usable even if remote Worker retirement requires
            // a separate cleanup pass. Exercise the public retry contract.
            const debtsAfterRetry = await instances((transport) => transport.retryCleanupDebt(name));
            log("cleanup retry outcome: " + JSON.stringify(debtsAfterRetry));
            assert.equal(debtsAfterRetry.some((entry) => entry.instance === name), false,
                "Committed deletion did not finish remote cleanup after the supported retry");
        }
        await assert.rejects(readFile(configPath), { code: "ENOENT" });
        await instances((transport) => transport.createInstance(draft));
        assert.equal((await instances((transport) => transport.deleteInstance(name))).cleanupPending, false);
        created = false;
        await assert.rejects(readFile(configPath), { code: "ENOENT" });
        assert.deepEqual((await instances((transport) => transport.listInstances())).map((entry) => entry.name).sort(), baseline);
        assert.equal((await instances((transport) => transport.listCleanupDebts())).some((debt) => debt.instance === name), false);
        return { instance: name, configCommits: 262, replayedRevisions: 3, gapRecovered: true,
            cancelledReadSettled: true, workerRestart: true, controlRestart: true,
            persistedAuditCalls: beforeAudit.length, persistedLogEntries: beforeLogs.length, persistedGoal: true, freshMcpExecution: true, nameReused: true };
    } finally {
        try {
            if (client) await client.close();
        } finally {
            if (created) await instances(async (transport) => {
                const existing = await transport.listInstances();
                if (existing.some((entry) => entry.name === name))
                    assert.equal((await transport.deleteInstance(name)).cleanupPending, false);
            });
        }
    }
}

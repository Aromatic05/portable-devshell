import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { call, connectWorkflow, eventually, instance, readWaitDocument, readWorkflowAudit, snapshot } from "./WorkflowSupport.mjs";

// Run via acceptance/run-workflow-chain-smoke.mjs. No service or tool is mocked.
// Host delivery is deliberately reported as rejected: this SDK is not ChatGPT.
export async function runWorkflowPersistentChain(fixture, record) {
    let client;
    const clients = [];
    const connect = async () => {
        client = await connectWorkflow(fixture);
        clients.push(client);
        record("sdk-connected", { connection: clients.length, transport: "SDK v2 StreamableHTTP" });
    };
    const taskApi = (operation) => fixture.control((shared, connection) => operation(shared.createTaskTransport(connection, instance)));
    const callsApi = (ctxId) => fixture.control((shared, connection) => shared.createToolTransport(connection, instance).listCalls({ ctxId, limit: 1000, includeInput: true, includeOutput: true }));
    const receipts = async () => JSON.parse(await readFile(join(fixture.home, ".devshell", "control", "workspace-app-leases.json.actions"), "utf8"));
    const marker = `L05-${randomUUID()}`;
    const objective = `workflow-${marker}`;
    const effectsFile = join(fixture.workspace, "effects.txt");
    const startedMarker = `${marker}-started`;
    const doneMarker = `${marker}-completed`;
    try {
        await fixture.start();
        record("control-worker-ready", { worker: fixture.worker, instance, root: fixture.root });
        await connect();
        const environment = await call(client, "environ_info", { workspace: fixture.workspace });
        const ctxId = environment.structuredContent.ctxId;
        assert.equal(typeof ctxId, "string");
        assert.ok(ctxId.length > 0);
        assert.equal((await call(client, "workspace_goal", { ctxId, action: "get" })).structuredContent.goal, null);
        const created = (await call(client, "workspace_goal", { ctxId, action: "start", objective })).structuredContent.goal;
        const goalId = created.goalId;
        assert.equal(typeof goalId, "string");
        const readGoal = async () => (await taskApi((api) => api.getGoal(ctxId))).goal;
        const initial = await readGoal();
        assert.equal(initial.objective, objective);
        assert.equal(initial.revision, created.revision);
        assert.equal(initial.status, "active");
        assert.equal(initial.workspace, fixture.workspace);
        record("persistent-goal-created", { ctxId, goalId, revision: initial.revision });

        const pause = { ctxId, itemId: goalId, actionId: "goal-pause", expectedRevision: initial.revision, requestId: randomUUID() };
        assert.equal((await call(client, "mcpapp_action", pause)).structuredContent.status, "applied");
        const paused = await readGoal();
        assert.equal(paused.status, "paused");
        assert.equal(paused.revision, initial.revision + 1);
        assert.equal((await call(client, "mcpapp_action", pause)).structuredContent.status, "applied");
        assert.deepEqual(await readGoal(), paused, "pause receipt replay mutated the Goal");
        await assert.rejects(client.callTool({ name: "mcpapp_action", arguments: { ctxId, itemId: goalId,
            actionId: "goal-resume", expectedRevision: initial.revision, requestId: randomUUID() } }),
        /changed from revision/iu, "stale Goal action must fail through the real MCP boundary");
        assert.deepEqual(await readGoal(), paused, "rejected action changed durable state");
        const faultMarker = `${marker}-exit7`;
        const fault = (await call(client, "bash_run", { ctxId, command: `printf '%s' '${faultMarker}'; printf '%s' '${faultMarker}-stderr' >&2; exit 7`, timeoutMs: 10000 })).structuredContent;
        assert.equal(fault.exitCode, 7);
        assert.equal(fault.stdout, faultMarker);
        assert.equal(fault.stderr, `${faultMarker}-stderr`);
        const resume = { ctxId, itemId: goalId, actionId: "goal-resume", expectedRevision: paused.revision, requestId: randomUUID() };
        assert.equal((await call(client, "mcpapp_action", resume)).structuredContent.status, "applied");
        const resumed = await readGoal();
        assert.equal(resumed.status, "active");
        assert.equal(resumed.revision, paused.revision + 1);
        const directive = (await snapshot(client, ctxId)).reentry.directives.find((entry) => entry.intent === "goal-resume" && entry.sourceId === goalId);
        assert.ok(directive?.id, "resume did not persist a recovery directive");
        record("action-error-recovery-and-replay", { goalId, directiveId: directive.id, revision: resumed.revision });

        // Gate completion on a file written by a later *real Worker* bash call.
        // A finite 10-minute guard prevents a failed harness leaving work alive.
        const command = `printf '%s\\n' '${startedMarker}' | tee -a ./effects.txt; n=0; while [ ! -f ./release ]; do n=$((n+1)); [ "$n" -lt 3000 ] || exit 97; sleep 0.2; done; printf '%s\\n' '${doneMarker}' | tee -a ./effects.txt`;
        record("long-tmux-starting", { handoffBudgetMs: 180000, timeoutMs: 360000 });
        const startedAt = Date.now();
        const launch = (await call(client, "tmux_run", { ctxId, command, wait: "block", timeout: 360000, line: 20 }, 240000)).structuredContent;
        const elapsedMs = Date.now() - startedAt;
        assert.equal(launch.detached, true, JSON.stringify(launch));
        assert.equal(launch.task?.status, "running");
        assert.ok(elapsedMs >= 170000 && elapsedMs < 230000, `real 180s handoff boundary: ${elapsedMs}ms`);
        const terminalTask = launch.task.id;
        assert.equal(typeof terminalTask, "string");
        assert.deepEqual((await readFile(effectsFile, "utf8")).trim().split("\n"), [startedMarker]);
        const readWaits = async () => (await taskApi((api) => api.getWaits(ctxId))).waits;
        const waits = await readWaits();
        const wait = waits.find((entry) => entry.targetId === terminalTask);
        assert.ok(wait, "tmux handoff did not traverse Wait persistence");
        assert.equal(wait.status, "detached");
        assert.equal(wait.ctxId, ctxId);
        assert.equal(wait.source, "mcp");
        assert.equal(waits.filter((entry) => entry.targetId === terminalTask).length, 1);
        assert.deepEqual((await readWaitDocument(fixture)).waits.find((entry) => entry.waitId === wait.waitId), wait);
        const beforeCalls = await callsApi(ctxId);
        const launchCalls = beforeCalls.filter((entry) => entry.toolName === "tmux_run");
        assert.equal(launchCalls.length, 1);
        assert.equal(launchCalls[0].callId, wait.callId);
        assert.equal(launchCalls[0].status, "completed");
        record("wait-detached-durable", { terminalTask, waitId: wait.waitId, callId: wait.callId, elapsedMs });

        // This actually shuts down the Wait monitor, Control and Worker owner.
        const beforeRestart = await readGoal();
        await client.close();
        await fixture.stop();
        await fixture.assertTmuxAlive(startedMarker);
        assert.equal((await readWaitDocument(fixture)).waits.find((entry) => entry.waitId === wait.waitId).status, "detached");
        const beforeDisk = readWorkflowAudit(fixture);
        assert.equal(beforeDisk.filter((row) => row.collection === "toolCalls" && row.value.callId === wait.callId).length, 1);
        assert.ok(beforeDisk.some((row) => row.collection === "events" && row.value.type === "wait.detached" && row.value.data?.waitId === wait.waitId));
        await fixture.start();
        await connect();
        assertGoalUnchanged(await readGoal(), beforeRestart, "Goal changed across Control restart");
        assert.equal((await readWaits()).find((entry) => entry.waitId === wait.waitId).status, "detached");
        assert.ok((await snapshot(client, ctxId)).reentry.directives.some((entry) => entry.id === directive.id));
        const beforeReplay = await readGoal();
        assert.equal((await call(client, "mcpapp_action", resume)).structuredContent.status, "applied");
        assertGoalUnchanged(await readGoal(), beforeReplay, "persisted action replay executed resume twice");
        const recovery = { ctxId, directiveId: directive.id, claimId: `claim-${randomUUID()}`, intent: "goal-resume", sourceId: goalId };
        const claim = (await call(client, "mcpapp_reentry", { ...recovery, action: "claim" })).structuredContent;
        assert.equal(claim.claimed, true);
        assert.match(claim.delivery.message, /workspace Goal/u);
        assert.ok(claim.delivery.modelContext);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, claimId: `competitor-${randomUUID()}`, action: "claim" })).structuredContent.claimed, false);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "validate" })).structuredContent.valid, true);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "attempt" })).structuredContent.attempted, true);
        assert.equal((await receipts()).receipts.find((entry) => entry.actionId === directive.id).status, "attempted");
        record("restart-one-directive-claimed", { directiveId: directive.id, hostDelivery: "not-sent" });

        await client.close();
        await fixture.stop();
        await fixture.assertTmuxAlive(startedMarker);
        await fixture.start();
        await connect();
        const repeated = (await call(client, "mcpapp_reentry", { ...recovery, action: "attempt" })).structuredContent;
        assert.equal(repeated.attempted, false);
        assert.equal(repeated.duplicate, true, "attempted receipt must survive the second restart");
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "report", outcome: "rejected" })).structuredContent.reported, true);
        assert.equal((await call(client, "mcpapp_reentry", { ...recovery, action: "claim" })).structuredContent.claimed, false);
        const settled = (await receipts()).receipts.find((entry) => entry.actionId === directive.id);
        assert.equal(settled.status, "settled");
        assert.equal(settled.outcome, "rejected");
        assert.equal((await snapshot(client, ctxId)).reentry.directives, undefined, "settled directive must leave the pending projection");
        record("restart-two-attempt-replay-fenced", { receipt: settled, hostDelivery: "simulated-rejected" });

        const release = (await call(client, "bash_run", { ctxId, command: "printf 'release\\n' > ./release", timeoutMs: 10000 })).structuredContent;
        assert.equal(release.exitCode, 0, "fresh Worker execution after reconnect failed");
        const completed = (await call(client, "tmux_read", { ctxId, task: terminalTask, line: -100, timeMs: 30000 }, 45000)).structuredContent;
        assert.equal(completed.task?.id, terminalTask);
        assert.equal(completed.task?.status, "0", JSON.stringify(completed));
        assert.match(completed.output.join("\n"), new RegExp(doneMarker, "u"));
        const finalWaits = await eventually(readWaits, (entries) => entries.find((entry) => entry.waitId === wait.waitId)?.status === "resolved", "restarted Wait monitor did not resolve", 45000);
        const finalWait = finalWaits.find((entry) => entry.waitId === wait.waitId);
        assert.equal(finalWait.result.task.id, terminalTask);
        assert.equal(finalWait.result.task.status, "0");
        assert.equal(finalWaits.filter((entry) => entry.targetId === terminalTask).length, 1, "recovery created a duplicate Wait");
        assert.deepEqual((await readFile(effectsFile, "utf8")).trim().split("\n"), [startedMarker, doneMarker], "command side effects must occur exactly once");
        const current = await readGoal();
        const finished = (await call(client, "workspace_goal", { ctxId, action: "finish",
            expectedGoalId: goalId, expectedRevision: current.revision,
        })).structuredContent.goal;
        assert.equal(finished.revision, current.revision + 1);
        assert.equal((await readGoal()).revision, finished.revision);
        assert.equal((await readGoal()).status, "completed");
        assert.equal((await taskApi(api => api.getGoals())).goals.filter(entry => entry.goalId === goalId).length, 0);
        const finalCalls = await callsApi(ctxId);
        assert.equal(finalCalls.filter((entry) => entry.toolName === "mcpapp_action" && entry.status === "failed").length, 1,
            "the stale revision failure must be audited once before successful recovery");
        const faultCall = finalCalls.find((entry) => entry.toolName === "bash_run" && entry.exitCode === 7);
        assert.ok(faultCall, "nonzero Worker shell result was not durably audited");
        const logEntries = await fixture.control((shared, connection) => shared.createProcessTransport(connection, instance).readLogs({ ctxId, callId: faultCall.callId, limit: 100 }));
        assert.equal(logEntries.filter((entry) => entry.stream === "stdout").map((entry) => entry.message).join(""), faultMarker);
        assert.equal(logEntries.filter((entry) => entry.stream === "stderr").map((entry) => entry.message).join(""), `${faultMarker}-stderr`);
        assert.equal(finalCalls.filter((entry) => entry.toolName === "tmux_run").length, 1);
        const resumeCalls = finalCalls.filter((entry) => entry.toolName === "mcpapp_action" && entry.input?.requestId === resume.requestId);
        assert.equal(resumeCalls.length, 1, "replayed action produced a second Instance execution");
        const attemptCalls = finalCalls.filter((entry) => entry.toolName === "mcpapp_reentry" && entry.input?.action === "attempt");
        assert.equal(attemptCalls.length, 1, "replayed attempt entered Instance twice");
        record("terminal-wait-goal-verified", { terminalTask, wait: finalWait, goal: await readGoal(), output: completed.output });

        // Stop to flush audit, then query SQLite read-only with no server helper.
        await client.close();
        await fixture.stop();
        const disk = readWorkflowAudit(fixture);
        const persistedCalls = disk.filter((row) => row.collection === "toolCalls").map((row) => row.value).filter((entry) => entry.ctxId === ctxId);
        assert.equal(new Set(persistedCalls.map((entry) => entry.callId)).size, persistedCalls.length);
        for (const audited of finalCalls) {
            const stored = persistedCalls.find((entry) => entry.callId === audited.callId);
            assert.ok(stored, `SQLite lost API ToolCall ${audited.callId}`);
            assert.equal(stored.status, audited.status);
            assert.equal(stored.toolName, audited.toolName);
            // App Actions and Reentry may traverse an Extension-owned inner
            // ToolCall. The durable record must preserve the same provenance
            // exposed by the authoritative Control query, not always 'mcp'.
            assert.equal(stored.source, audited.source);
        }
        const launchRecord = persistedCalls.find((entry) => entry.callId === wait.callId);
        assert.deepEqual(launchRecord, beforeDisk.find((row) => row.collection === "toolCalls" && row.value.callId === wait.callId).value,
            "restart changed the original durable tmux execution audit");
        const waitEvents = disk.filter((row) => row.collection === "events" && row.value.data?.waitId === wait.waitId).map((row) => row.value);
        assert.deepEqual(waitEvents.map((entry) => entry.type), ["wait.detached", "wait.resolved"]);
        assert.ok(waitEvents[1].seq > waitEvents[0].seq);
        const goalEvents = disk.filter(row => row.collection === "events" && row.value.type === "goal.updated" && row.value.data?.goalId === goalId).map(row => row.value);
        assert.ok(goalEvents.some(event => event.data.ctxId === ctxId && event.data.status === "completed"), "missing durable Goal completion event");
        assert.ok(goalEvents.every((event, index) => index === 0 || event.seq > goalEvents[index - 1].seq));
        const storedGoals = JSON.parse(await readFile(join(fixture.state, "goals.json"), "utf8")).goals;
        const storedGoal = storedGoals.filter(entry => entry.createdByCtxId === ctxId);
        assert.equal(storedGoal.length, 1);
        for (const field of ["goalId", "objective", "revision", "status", "note", "workspace", "createdAt", "updatedAt"]) {
            assert.equal(storedGoal[0][field], finished[field], `disk lost completed Goal field ${field}`);
        }
        const diskLogs = disk.filter((row) => row.collection === "logs" && row.value.callId === faultCall.callId).map((row) => row.value);
        assert.equal(diskLogs.filter((entry) => entry.stream === "stdout").map((entry) => entry.message).join(""), faultMarker);
        assert.equal(diskLogs.filter((entry) => entry.stream === "stderr").map((entry) => entry.message).join(""), `${faultMarker}-stderr`);
        const terminalRead = persistedCalls.find((entry) => entry.toolName === "tmux_read" && entry.output?.output?.some((line) => line.includes(doneMarker)));
        assert.ok(terminalRead, "SQLite must retain the independently verified terminal completion output");
        assert.deepEqual((await readWaitDocument(fixture)).waits.find((entry) => entry.waitId === wait.waitId), finalWait);
        record("sqlite-audit-events-verified", { calls: persistedCalls.length, waitEvents, launchCount: 1, resumeExecutions: 1, attemptExecutions: 1 });
        return { ctxId, goalId, terminalTask, waitId: wait.waitId, restarts: 2, connections: clients.length,
            handoffElapsedMs: elapsedMs, hostDelivery: "simulated-rejected", persistentGoal: true,
            waitResolved: true, noDuplicateExecution: true, sqliteAuditVerified: true,
            scope: "Goal, Wait and action reentry; native ChatGPT Host delivery is not exercised" };
    } finally {
        for (const connected of clients) await connected.close();
    }
}

// Only continuationDue is computed from the wall clock at read time.
function assertGoalUnchanged(actual, expected, message) {
    const actualState = { ...actual };
    const expectedState = { ...expected };
    delete actualState.continuationDue;
    delete expectedState.continuationDue;
    assert.deepEqual(actualState, expectedState, message);
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import * as shared from "@portable-devshell/shared";
import { resolveControlSocketPath } from "../../packages/shared/src/testing.ts";
import { createCliClients, negotiateCliControl } from "../../packages/cli/src/transport/Client.ts";
import { createAcceptanceFixture, readAuditCollections, resolvePreparedWorker, runCli } from "../AcceptanceSupport.mjs";
import { resolveChromiumExecutable } from "../../scripts/testspace/TestspaceWebSmoke.mjs";
import { launchBrowser, until, within } from "./CrossClientBrowser.mjs";

const instance = "crossclient-local";
const report = { assignment: "L03-crossclient", status: "running", chains: [], tui: "not exercised; real CLI process and CLI native transport only" };
let phase = "preflight";
let fixture;
let browser;
let cli;
let endpoint;
let peerEndpoint;
let mcp;
const streams = new Set();
const observers = [];
let controlAttempted = false;
let exitCode = 0;
const mark = (name, evidence) => {
    report.chains.push({ name, status: "passed", ...evidence });
    process.stdout.write(`${JSON.stringify({ chain: name, status: "passed", ...evidence })}\n`);
};

try {
    const executable = resolveChromiumExecutable();
    assert.equal(typeof executable, "string", "Chromium required; no skipped-green result");
    const worker = resolvePreparedWorker();
    if (process.argv.includes("--preflight")) {
        report.status = "preflight-only";
        report.dependencies = { chromium: executable, worker, sourceTransportsImported: true };
        report.gaps = ["No Control, Worker, MCP request or browser session started"];
    } else {
        phase = "fixture.loopback-bind";
        fixture = await createAcceptanceFixture();
        // AcceptanceSupport's default name is never addressed by a command.
        // Rename its fresh, unstarted config before any Control can load it.
        const directory = join(fixture.home, ".devshell", "control", "instances");
        const original = join(directory, "aromatic-pc.toml");
        const target = join(directory, `${instance}.toml`);
        await rename(original, target);
        await writeFile(target, (await readFile(target, "utf8")).replaceAll("aromatic-pc", instance));
        // Explicit socketPath and a sanitized CLI environment prohibit an inherited
        // remote Control URL or user runtime from routing outside this fixture.
        delete fixture.env.PORTABLE_DEVSHELL_CONTROL_URL;
        delete fixture.env.PORTABLE_DEVSHELL_CONTROL_TOKEN;
        fixture.env.XDG_CONFIG_HOME = join(fixture.home, ".config");
        fixture.env.XDG_CACHE_HOME = join(fixture.home, ".cache");
        fixture.env.XDG_DATA_HOME = join(fixture.home, ".local", "share");
        fixture.env.TMPDIR = fixture.runtime;
        delete fixture.env.DEVSHELL_WORKER_INTERNAL_INSTANCE;
        delete fixture.env.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
        delete fixture.env.DEVSHELL_WORKER_INTERNAL_WORKSPACE;
        report.isolation = { instance, root: fixture.root, mcpPort: fixture.port, webPort: fixture.webPort };
        phase = "cli.control-worker-start";
        controlAttempted = true;
        runCli(["start"], fixture.env);
        runCli(["instance", "start", instance], fixture.env);
        const socketPath = resolveControlSocketPath(fixture.runtime, process.platform, fixture.env);
        cli = createCliClients({ environment: fixture.env, socketPath });
        await negotiateCliControl(cli);
        endpoint = new shared.Endpoint({ connectChannel: (signal) => shared.LocalChannel.connect(socketPath, { signal }) });
        await shared.createServerTransport(endpoint, { clientKind: "cli" }).hello();
        const processApi = shared.createProcessTransport(endpoint, instance);
        const taskApi = shared.createTaskTransport(endpoint, instance);
        peerEndpoint = new shared.Endpoint({ connectChannel: (signal) => shared.LocalChannel.connect(socketPath, { signal }) });
        await shared.createServerTransport(peerEndpoint, { clientKind: "cli" }).hello();
        const peerTaskApi = shared.createTaskTransport(peerEndpoint, instance);
        const assertContextVisible = async () => {
            const native = await shared.createContextTransport(endpoint).validateForInstance(ctxId, instance);
            const peer = (await cli.context.list({ instance })).find(context => context.ctxId === ctxId);
            assert.ok(peer, "CLI transport lost the MCP Context");
            assert.deepEqual(peer.environments, native.environments);
            assert.ok(native.environments.some(environment => environment.instance === instance && environment.workspace === fixture.workspace));
            const listed = JSON.parse(runCli(["context", "list"], fixture.env).stdout);
            assert.equal(listed.filter(context => context.ctxId === ctxId).length, 1);
        };
        const approvalApi = shared.createApprovalTransport(endpoint, instance);
        const toolApi = shared.createToolTransport(endpoint, instance);
        const configApi = shared.createConfigTransport(endpoint);
        const cliStatus = (status) => {
            const result = runCli(["instance", "status", instance], fixture.env);
            assert.match(result.stdout, new RegExp(`^status: ${status}$`, "mu"));
            return result.status;
        };
        const authoritative = async (status) => {
            const state = await until(() => processApi.snapshot(), (value) => value.snapshot.status === status, `native state ${status}`);
            assert.equal(state.snapshot.ready, status === "ready");
            assert.equal((await cli.runtime(instance).snapshot()).snapshot.status, status);
            cliStatus(status);
            return state;
        };
        await authoritative("ready");
        mcp = new Client({ name: "round7-crossclient", version: "1" }, { versionNegotiation: { mode: "auto" } });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${fixture.port}/${instance}/mcp`)));
        const call = async (name, args) => {
            const result = await within(mcp.callTool({ name, arguments: args }), `MCP ${name}`);
            assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
            assert.ok(result.structuredContent, `${name} missing structuredContent`);
            return result.structuredContent;
        };
        let ctxId = (await call("environ_info", { workspace: fixture.workspace })).ctxId;
        assert.equal(typeof ctxId, "string");
        // Rust Worker executes an observable filesystem effect; independent Node
        // read proves actual execution, not merely a successful tool envelope.
        const effectFile = join(fixture.workspace, "crossclient-effects.txt");
        const workerResult = await call("bash_run", {
            ctxId, command: "printf 'initial\n' >> crossclient-effects.txt; cat crossclient-effects.txt", timeoutMs: 10_000,
        });
        assert.equal(workerResult.exitCode, 0);
        assert.equal(await readFile(effectFile, "utf8"), "initial\n");
        mark("cli-mcp-real-worker", { cliExit: 0, workerExit: workerResult.exitCode, fileEffect: "exactly one initial line" });

        phase = "web.rpc-failure-stop-start-observers";
        browser = await launchBrowser(executable, fixture);
        await browser.visit("#/instances");
        await browser.wait(`(() => {
            const link = [...document.querySelectorAll('a[href]')].find(a => a.textContent?.trim() === ${JSON.stringify(instance)});
            if (!link) return false; link.click(); return true;
        })()`, "instance link");
        await browser.wait("document.body.innerText.includes('Runtime: ready')", "Web ready");
        const cursor = (await processApi.snapshot()).lastSeq;
        const nativeProcessStream = await processApi.subscribe(cursor + 1);
        const cliProcessStream = await cli.runtime(instance).subscribe(cursor + 1);
        const nativeObserver = observe(nativeProcessStream, false);
        const cliObserver = observe(cliProcessStream, true);
        observers.push(nativeObserver, cliObserver);
        await browser.click("Stop");
        await browser.wait(`(() => {
            const button = [...document.querySelectorAll('[role="dialog"] button')]
                .find(node => node.textContent?.trim() === 'Stop');
            if (!button || button.disabled) return false;
            globalThis.__crossClientFault.armed = true;
            button.click(); return true;
        })()`, "arm transport fault and confirm Stop in one browser task");
        await browser.wait("globalThis.__crossClientFault.hits === 1", "one failed real RPC send");
        await browser.wait("[...document.querySelectorAll('[role=alert]')].some(el => el.textContent.trim().length > 0)", "visible failed action");
        await authoritative("ready");
        assert.equal(nativeObserver.events.filter(event => event.type === "instance.stopped").length, 0);
        await browser.reload();
        await browser.wait("document.body.innerText.includes('Runtime: ready')", "reload retains authoritative ready");
        await browser.click("Stop");
        await browser.click("Stop", true);
        await browser.wait("document.body.innerText.includes('Runtime: stopped')", "Web stop");
        await authoritative("stopped");
        await browser.click("Start");
        await browser.wait("document.body.innerText.includes('Runtime: ready')", "Web restart Worker");
        const restarted = await authoritative("ready");
        for (const observer of [nativeObserver, cliObserver]) {
            await until(() => observer.events, events => events.some(event => event.type === "instance.started"), "independent lifecycle stream");
            assert.equal(observer.error, undefined);
            assert.equal(observer.events.filter(event => event.type === "instance.stopped").length, 1, "No duplicate Stop side effect");
            assert.equal(observer.events.filter(event => event.type === "instance.started").length, 1, "No duplicate Start side effect");
            assert.ok(observer.events.every((event, index, events) => index === 0 || event.seq > events[index - 1].seq));
        }
        assert.deepEqual(nativeObserver.events.filter(event => ["instance.stopped", "instance.started"].includes(event.type)),
            cliObserver.events.filter(event => ["instance.stopped", "instance.started"].includes(event.type)));
        await nativeObserver.close();
        await cliObserver.close();
        // Reacquire model context after the real Worker lifecycle change.
        ctxId = (await call("environ_info", { workspace: fixture.workspace })).ctxId;
        assert.equal((await call("bash_run", { ctxId, command: "printf 'recovered\n' >> crossclient-effects.txt", timeoutMs: 10_000 })).exitCode, 0);
        assert.equal(await readFile(effectFile, "utf8"), "initial\nrecovered\n");
        const auditDatabase = join(fixture.home, ".devshell", instance, "control-worker", "audit.sqlite3");
        const lifecycleEvents = readAuditCollections(auditDatabase)
            .filter(row => row.collection === "events").map(row => JSON.parse(row.payload))
            .filter(event => event.seq > cursor && ["instance.stopped", "instance.started"].includes(event.type));
        assert.deepEqual(lifecycleEvents, nativeObserver.events.filter(event => ["instance.stopped", "instance.started"].includes(event.type)));
        mark("web-failed-rpc-worker-restart-cross-observers", {
            failure: "one native WebSocket send throws before forwarding; UI alert asserted",
            stoppedEvents: 1, startedEvents: 1, matchingNativeAndCliEvents: true, finalSeq: restarted.lastSeq,
        });

        phase = "mcp-goal-revision-replay-web";
        const objective = `CrossClient-${randomUUID()}`;
        await assertContextVisible();
        assert.equal((await call("workspace_goal", { ctxId, action: "get" })).goal, null);
        let goal = (await call("workspace_goal", { ctxId, action: "start", objective })).goal;
        const goalId = goal.goalId;
        assert.equal(typeof goalId, "string");
        const readGoal = () => taskApi.getGoal(ctxId);
        const before = await readGoal();
        assert.equal(before.goal.revision, goal.revision);
        assert.equal(before.goal.objective, objective);
        assert.equal((await peerTaskApi.getGoal(ctxId)).goal.goalId, goalId);
        const taskStream = await taskApi.subscribe(before.lastSeq + 1);
        streams.add(taskStream);
        const updated = { ctxId, action: "update", expectedGoalId: goalId, expectedRevision: goal.revision,
            note: "crossclient-update-1" };
        goal = (await call("workspace_goal", updated)).goal;
        assert.equal(goal.revision, before.goal.revision + 1);
        const event = await within(taskStream.next(), "live Goal event");
        assert.equal(event.kind, "event");
        assert.equal(event.event.type, "goal.updated");
        assert.equal(event.event.data.goalId, goalId);
        assert.equal(event.event.data.ctxId, ctxId);
        assert.ok(event.event.seq > before.lastSeq);
        assert.equal((await readGoal()).goal.revision, goal.revision);
        taskStream.close(); streams.delete(taskStream);
        await assert.rejects(mcp.callTool({ name: "workspace_goal", arguments: {
            ...updated, note: "crossclient-stale-should-not-apply",
        } }), /changed from revision/iu, "stale Goal mutation must fail through MCP");
        assert.equal((await readGoal()).goal.revision, goal.revision);
        assert.equal((await readGoal()).goal.note, updated.note);
        const pause = { ctxId, itemId: goalId, actionId: "goal-pause", expectedRevision: goal.revision, requestId: randomUUID() };
        assert.equal((await call("mcpapp_action", pause)).status, "applied");
        const paused = await readGoal();
        assert.equal(paused.goal.status, "paused");
        assert.equal(paused.goal.revision, goal.revision + 1);
        assert.equal((await call("mcpapp_action", pause)).status, "applied");
        assert.deepEqual((await readGoal()).goal, paused.goal, "Same requestId must not apply pause twice");
        assert.equal((await call("mcpapp_action", { ctxId, itemId: goalId, actionId: "goal-resume", expectedRevision: paused.goal.revision, requestId: randomUUID() })).status, "applied");
        goal = (await readGoal()).goal;
        assert.equal(goal.status, "active");
        assert.equal(goal.revision, paused.goal.revision + 1);
        await browser.visit("#/goals");
        await assertWebGoal(browser, objective, goal.revision);
        await browser.reload();
        await assertWebGoal(browser, objective, goal.revision);
        assert.equal((await peerTaskApi.getGoal(ctxId)).goal.revision, goal.revision);
        mark("mcp-goal-crossclient-revision", { ctxId, goalId, revision: goal.revision, eventSeq: event.event.seq, staleRejected: true, replayNoRevisionChange: true, hardReload: true });

        phase = "mcp-approval-web-decision-audit";
        await configApi.update({ instance: { instanceName: instance, patch: {
            approvalPolicy: { mode: "allow", rules: [{ decision: "ask", match: "exact", source: "mcp", toolName: "bash_run" }] },
        } } });
        const approvalCursor = (await approvalApi.snapshot()).lastSeq;
        const approvalStream = await approvalApi.subscribe(approvalCursor + 1);
        streams.add(approvalStream);
        // Attach rejection handler immediately: a protocol rejection must remain
        // a test failure when the operation is awaited, never an unhandled rejection.
        const operation = mcp.callTool({ name: "bash_run", arguments: {
            ctxId, command: "printf 'approved\n' >> crossclient-effects.txt", timeoutMs: 10_000,
        } }).then(value => ({ value }), error => ({ error }));
        const pending = await until(() => approvalApi.snapshot({ pendingOnly: true }),
            value => value.approvals.some(item => item.ctxId === ctxId && item.toolName === "bash_run"), "MCP pending approval");
        const approval = pending.approvals.find(item => item.ctxId === ctxId && item.toolName === "bash_run");
        const requested = await within(approvalStream.next(), "approval.requested");
        assert.equal(requested.kind, "event");
        assert.equal(requested.event.type, "approval.requested");
        assert.equal(requested.event.data.approvalId, approval.approvalId);
        assert.match(runCli(["approval", "show", instance, approval.approvalId], fixture.env).stdout, /pending/u);
        assert.equal(await readFile(effectFile, "utf8"), "initial\nrecovered\n", "Pending approval must fence Worker side effect");
        await browser.visit("#/audit");
        await browser.click("Approve");
        await browser.click("Approve", true);
        const settled = await within(operation, "approved Worker tool");
        assert.equal(settled.error, undefined);
        assert.notEqual(settled.value.isError, true);
        assert.equal(settled.value.structuredContent.exitCode, 0);
        assert.equal(await readFile(effectFile, "utf8"), "initial\nrecovered\napproved\n");
        const decision = await approvalApi.get(approval.approvalId);
        assert.equal(decision.status, "approved");
        assert.equal(decision.decision.decidedBy, "web");
        const approved = await within(approvalStream.next(), "approval.approved");
        assert.equal(approved.kind, "event");
        assert.equal(approved.event.type, "approval.approved");
        assert.equal(approved.event.data.approvalId, approval.approvalId);
        assert.ok(approved.event.seq > requested.event.seq);
        approvalStream.close(); streams.delete(approvalStream);
        // The current approval service explicitly rejects a second decision.
        const repeat = runCli(["approval", "approve", instance, approval.approvalId], fixture.env, { allowFailure: true });
        assert.equal(repeat.status, 1);
        assert.match(repeat.stderr, /already decided/u);
        assert.deepEqual(await approvalApi.get(approval.approvalId), decision);
        assert.equal(await readFile(effectFile, "utf8"), "initial\nrecovered\napproved\n");
        const calls = await until(() => toolApi.listCalls({ ctxId, limit: 200 }),
            rows => rows.some(row => row.callId === approval.callId && row.status === "completed"), "approved ToolCall audit");
        assert.equal(calls.filter(row => row.callId === approval.callId).length, 1);
        await browser.visit(`#/audit/context/${encodeURIComponent(instance)}/${encodeURIComponent(ctxId)}/call/${encodeURIComponent(approval.callId)}`);
        await browser.reload();
        await browser.wait(`(() => {
            const record = [...document.querySelectorAll('.tool-call-record')].find(node =>
                [...node.querySelectorAll('dd')].some(dd => dd.textContent === ${JSON.stringify(approval.callId)}));
            return !!record && record.innerText.includes(${JSON.stringify(ctxId)}) &&
                record.innerText.includes('bash_run') && record.querySelector('.result')?.textContent === 'completed';
        })()`, "exact completed ToolCall in Web audit after hard reload");
        const db = auditDatabase;
        await until(() => Promise.resolve(readAuditCollections(db)), rows => rows.some(row =>
            row.collection === "toolCalls" && JSON.parse(row.payload).callId === approval.callId && JSON.parse(row.payload).status === "completed"), "durable SQLite audit");
        const durableDecisions = readAuditCollections(db).filter(row => row.collection === "events")
            .map(row => JSON.parse(row.payload))
            .filter(event => event.type === "approval.approved" && event.data.approvalId === approval.approvalId);
        assert.equal(durableDecisions.length, 1, "One durable approval decision despite CLI retry");
        mark("mcp-approval-web-worker-durable-audit", { approvalId: approval.approvalId, callId: approval.callId,
            decidedBy: "web", repeatCliExit: repeat.status, workerEffects: 1, hardReload: true });

        phase = "stale-snapshot-retention-gap-recovery";
        // Leave one stale reader disconnected while >50 REAL Goal changes cross
        // MCP ingress. eventBufferSize=50 is configured by AcceptanceFixture.
        const staleCursor = (await readGoal()).lastSeq + 1;
        for (let index = 0; index < 60; index++) {
            goal = (await call("workspace_goal", { ctxId, action: "update", expectedGoalId: goalId,
                expectedRevision: goal.revision, note: `crossclient-gap-${index}` })).goal;
        }
        // Initial unavailable cursor is a normal stream.gap cancellation in
        // ProcessSubscriptionManager, not a synthetic gap envelope.
        const staleStream = await taskApi.subscribe(staleCursor);
        streams.add(staleStream);
        const gap = await within(staleStream.next(), "real bounded-retention gap");
        assert.equal(gap.kind, "closed");
        assert.equal(gap.error?.code, "stream.gap");
        assert.equal(gap.error.details.requestedFromSeq, staleCursor);
        assert.ok(gap.error.details.oldestAvailableSeq > staleCursor);
        staleStream.close(); streams.delete(staleStream);
        // CLI's actual endpoint reconnect and authoritative reload closes the
        // stale snapshot window. A fresh subscription must see the next commit.
        await cli.reconnect();
        await negotiateCliControl(cli);
        await peerEndpoint.reconnect();
        await shared.createServerTransport(peerEndpoint, { clientKind: "cli" }).hello();
        await assertContextVisible();
        const fresh = await peerTaskApi.getGoal(ctxId);
        assert.equal(fresh.goal.revision, goal.revision);
        const recoveredStream = await peerTaskApi.subscribe(fresh.lastSeq + 1);
        streams.add(recoveredStream);
        goal = (await call("workspace_goal", { ctxId, action: "update", expectedGoalId: goalId,
            expectedRevision: goal.revision, note: "crossclient-gap-recovered" })).goal;
        const recovered = await within(recoveredStream.next(), "independent CLI endpoint resumed real Goal event");
        assert.equal(recovered.kind, "event");
        const recoveredEvent = recovered.event;
        assert.equal(recoveredEvent.type, "goal.updated");
        assert.equal(recoveredEvent.data.goalId, goalId);
        assert.equal(recoveredEvent.data.ctxId, ctxId);
        recoveredStream.close(); streams.delete(recoveredStream);
        await browser.visit("#/goals");
        await browser.reload();
        await assertWebGoal(browser, objective, goal.revision);
        const final = await readGoal();
        assert.equal(final.goal.revision, goal.revision);
        assert.equal(final.goal.note, "crossclient-gap-recovered");
        assert.equal((await taskApi.getGoals()).goals.filter(entry => entry.goalId === goalId).length, 1);
        const diskGoals = JSON.parse(await readFile(join(fixture.home, ".devshell", instance, "control-worker", "goals.json"), "utf8"));
        const diskGoal = diskGoals.goals.filter(entry => entry.createdByCtxId === ctxId);
        assert.equal(diskGoal.length, 1);
        assert.equal(diskGoal[0].goalId, goalId);
        assert.equal(diskGoal[0].revision, goal.revision);
        assert.equal(diskGoal[0].note, "crossclient-gap-recovered");
        await authoritative("ready");
        mark("stale-snapshot-gap-reconnect-final-consistency", { gapCode: gap.error.code, staleCursor,
            oldestAvailableSeq: gap.error.details.oldestAvailableSeq, revision: goal.revision, recoveredEventSeq: recoveredEvent.seq,
            nativeCliWebAndDiskAgree: true });

        phase = "temporary-control-restart-durable-crossclient-reload";
        // Restart only the fixture Control through its isolated CLI environment.
        // Reuse the real clients' reconnect paths and discard browser memory.
        await mcp.close();
        mcp = undefined;
        runCli(["instance", "stop", instance], fixture.env);
        runCli(["stop"], fixture.env);
        await browser.wait("!document.body.innerText.includes('Online')", "Web detects stopped fixture Control");
        runCli(["start"], fixture.env);
        runCli(["instance", "start", instance], fixture.env);
        await endpoint.reconnect();
        await shared.createServerTransport(endpoint, { clientKind: "cli" }).hello();
        await cli.reconnect();
        await negotiateCliControl(cli);
        await authoritative("ready");
        const restored = await readGoal();
        const finalState = { ...final.goal };
        const restoredState = { ...restored.goal };
        delete finalState.continuationDue;
        delete restoredState.continuationDue;
        // Due eligibility is computed against the current clock; persisted fields must agree.
        assert.deepEqual(restoredState, finalState, "Goal must survive Control restart exactly");
        assert.ok(restored.lastSeq > final.lastSeq, "Durable event cursor must advance across restart");
        assert.deepEqual(await approvalApi.get(approval.approvalId), decision, "Web decision must survive Control restart");
        const restoredCalls = await toolApi.listCalls({ callIds: [approval.callId], limit: 10 });
        assert.equal(restoredCalls.length, 1);
        assert.equal(restoredCalls[0].status, "completed");
        assert.equal(await readFile(effectFile, "utf8"), "initial\nrecovered\napproved\n", "Restart must not replay approved Worker command");
        await assertContextVisible();
        await peerEndpoint.reconnect();
        await shared.createServerTransport(peerEndpoint, { clientKind: "cli" }).hello();
        assert.deepEqual((await peerTaskApi.getGoal(ctxId)).goal, restored.goal);
        assert.match(runCli(["approval", "show", instance, approval.approvalId], fixture.env).stdout, /approved/u);
        await browser.reload();
        await assertWebGoal(browser, objective, goal.revision);
        await browser.visit(`#/audit/context/${encodeURIComponent(instance)}/${encodeURIComponent(ctxId)}/call/${encodeURIComponent(approval.callId)}`);
        await browser.reload();
        await browser.wait(`document.body.innerText.includes(${JSON.stringify(approval.callId)}) &&
            [...document.querySelectorAll('.tool-call-record .result')].some(node => node.textContent === 'completed')`, "exact durable audit after Control restart");
        mark("control-restart-durable-final-state", { cliExits: [0, 0, 0, 0], revision: restored.goal.revision,
            lastSeq: restored.lastSeq, approvedCallCount: 1, workerCommandNotReplayed: true,
            webHardReload: true, nativeAndCliReload: true });
        report.status = "passed";
    }
} catch (error) {
    exitCode = phase === "fixture.loopback-bind" && error.code === "EPERM" ? 2 : 1;
    report.status = exitCode === 2 ? "environment-blocked" : "failed";
    report.failure = { phase, code: error.code, message: error.message, stack: error.stack };
} finally {
    const cleanupErrors = [];
    const cleanup = async (label, action) => {
        try { await action(); }
        catch (error) { cleanupErrors.push({ label, message: error.message }); }
    };
    for (const observer of observers) await cleanup("observer", () => observer.close());
    for (const stream of streams) await cleanup("stream", () => stream.close());
    if (browser) await cleanup("Chromium", () => browser.close());
    if (mcp) await cleanup("MCP", () => mcp.close());
    cli?.close(); endpoint?.close(); peerEndpoint?.close();
    if (fixture) {
        if (controlAttempted) {
            await cleanup("temporary instance stop", () => runCli(["instance", "stop", instance], fixture.env));
            await cleanup("temporary Control stop", () => runCli(["stop"], fixture.env));
        }
        await cleanup("temporary HOME removal", () => rm(fixture.root, { recursive: true, force: true }));
    }
    report.cleanup = cleanupErrors.length === 0 ? "completed" : cleanupErrors;
    if (cleanupErrors.length > 0) { exitCode = 1; report.status = "failed"; }
    report.exitCode = exitCode;
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = exitCode;
}

async function assertWebGoal(page, objective, revision) {
    await page.wait(`(() => {
        const cards = [...document.querySelectorAll('article.card')].filter(card =>
            [...card.querySelectorAll('h4')].some(node => node.textContent === ${JSON.stringify(objective)}));
        return cards.length === 1 && cards[0].innerText.includes(${JSON.stringify(`revision ${revision}`)});
    })()`, `one Web Goal at revision ${revision}`);
}

function observe(stream, cliAdapter) {
    let closing = false;
    const observer = { events: [], error: undefined };
    const pump = (async () => {
        try {
            while (!closing) {
                const message = cliAdapter ? { kind: "event", event: await stream.nextEvent() } : await stream.next();
                if (closing) break;
                assert.equal(message.kind, "event", "Live observer must not silently lose events");
                observer.events.push(message.event);
            }
        } catch (error) { if (!closing) observer.error = error; }
    })();
    observer.close = async () => {
        closing = true;
        stream.close();
        await within(pump, "observer close");
        assert.equal(observer.error, undefined, observer.error?.stack);
    };
    return observer;
}

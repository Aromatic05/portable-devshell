import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import {
    createAcceptanceFixture,
    readAuditCollections,
    resolvePreparedWorker,
    runCli,
    workerEnvironmentName,
} from "./AcceptanceSupport.mjs";
import { withTestspaceControlConnection } from "../scripts/testspace/TestspaceReverse.mjs";

const fixture = await createAcceptanceFixture();
const instanceName = `provider-chain-${process.pid}`;
const reverseHome = join(fixture.root, "reverse-worker-home");
const reverseRuntime = join(fixture.root, "reverse-worker-runtime");
const reverseDevShellHome = join(reverseHome, ".devshell");
const reverseWorkspace = join(fixture.root, "reverse-workspace");
const marker = join(reverseWorkspace, "side-effect.txt");
const workerPath = resolvePreparedWorker();
const workerEnv = {
    ...fixture.env,
    HOME: reverseHome,
    PORTABLE_DEVSHELL_HOME: reverseDevShellHome,
    USERPROFILE: reverseHome,
    XDG_RUNTIME_DIR: reverseRuntime,
    [workerEnvironmentName()]: workerPath,
};
delete workerEnv.DEVSHELL_WORKER_INTERNAL_INSTANCE;
delete workerEnv.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
delete workerEnv.DEVSHELL_WORKER_INTERNAL_WORKSPACE;

let controlStarted = false;
let instanceExists = false;
let workerMayRun = false;
let client;
let primaryFailure;

try {
    await Promise.all([
        mkdir(reverseHome, { recursive: true }),
        mkdir(reverseRuntime, { recursive: true }),
        mkdir(reverseWorkspace, { recursive: true }),
    ]);

    runCli(["start"], fixture.env);
    controlStarted = true;
    stage("isolated Control started on dynamically reserved loopback port");

    const created = await withTestspaceControlConnection(
        fixture.runtime,
        async (shared, endpoint) => {
            const instances = shared.createInstanceTransport(endpoint);
            const result = await instances.createInstance({
                name: instanceName,
                provider: "reverse",
                enabled: true,
                mcp: { enabled: true, auth: "none", contextMode: "explicit" },
                extensions: { model: ["artifact", "instance", "mcp", "secret", "skill"] },
                logs: { eventBufferSize: 100 },
            });
            instanceExists = true;
            const code = await shared.createConnectionTransport(endpoint).createCode(instanceName);
            return { result, code };
        },
    );
    assert.equal(created.result.name, instanceName);
    assert.match(created.code.deviceCode, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/u);
    stage("Control API created Reverse Instance and issued one-time enrollment code");

    const rejected = runWorker([
        "enroll", "--controller", created.code.controllerUrl,
        "--device-code", "INVALID-CODE",
    ], true);
    assert.notEqual(rejected.status, 0, `${rejected.stdout}\n${rejected.stderr}`);
    assert.match(`${rejected.stdout}${rejected.stderr}`, /rejected|invalid|expired|consumed/iu);
    const freshCode = await withTestspaceControlConnection(
        fixture.runtime,
        async (shared, endpoint) =>
            await shared.createConnectionTransport(endpoint).createCode(instanceName),
    );
    stage("invalid enrollment failed and Control issued a fresh code");

    workerMayRun = true;
    const enrolled = runWorker([
        "enroll", "--controller", freshCode.controllerUrl,
        "--device-code", freshCode.deviceCode,
    ]);
    assert.equal(enrolled.status, 0, `${enrolled.stdout}\n${enrolled.stderr}`);
    assert.match(enrolled.stdout, new RegExp(`"instance":\\s*"${instanceName}"`, "u"));
    const enrollResult = JSON.parse(enrolled.stdout);
    assert.equal(enrollResult.started, true);
    assert.equal(enrollResult.connected, true, enrolled.stdout);
    await waitForReady(fixture.runtime, instanceName);
    stage("real Rust Worker enrolled, installed in isolated HOME, and connected over Reverse transport");

    const endpoint = `http://127.0.0.1:${fixture.port}/${instanceName}/mcp`;
    client = new Client({ name: "provider-chain-acceptance", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const available = await client.listTools();
    assert.equal(available.tools.some((tool) => tool.name === "environ_info"), true);
    assert.equal(available.tools.some((tool) => tool.name === "bash_run"), true);
    const environment = await client.callTool({
        name: "environ_info",
        arguments: { workspace: reverseWorkspace },
    });
    assert.notEqual(environment.isError, true, JSON.stringify(environment));
    const ctxId = environment.structuredContent?.ctxId;
    assert.equal(typeof ctxId, "string");
    assert.notEqual(ctxId, "");

    const write = await callBash(client, ctxId, `printf x >> '${marker}'; wc -c < '${marker}'`);
    assert.equal(write.exitCode, 0, JSON.stringify(write));
    assert.match(write.stdout, /^\s*1\s*$/u);
    stage("MCP SDK tools/call traversed Control and Reverse transport to Rust Worker; durable side effect count is 1");

    const firstSnapshot = await readSnapshot(fixture.runtime, instanceName);
    assert.equal(firstSnapshot.ready, true);
    assert.equal(firstSnapshot.reverse.transport, "wss");
    const auditPath = join(fixture.home, ".devshell", instanceName, "control-worker", "audit.sqlite3");
    const records = readAuditCollections(auditPath);
    assert.ok(records.some((row) => row.collection === "toolCalls" && row.payload.includes('"toolName":"bash_run"')));
    assert.ok(records.some((row) => row.collection === "events" && row.payload.includes('"type":"toolCall.completed"')));
    assert.equal(await readFile(marker, "utf8"), "x");
    stage("independent Control snapshot, SQLite audit/event records, and Worker filesystem state verified");

    await client.close();
    client = undefined;
    runWorker(["stop", "--instance", instanceName]);
    workerMayRun = false;
    await waitForOffline(fixture.runtime, instanceName);
    const offlineCall = new Client({ name: "provider-chain-offline-probe", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await offlineCall.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    let offlineBlocked = false;
    try {
        const failedCall = await offlineCall.callTool({
            name: "bash_run",
            arguments: {
                command: `printf x >> '${join(reverseWorkspace, "should-not-run")}'`,
                ctxId,
                timeoutMs: 5_000,
            },
        });
        offlineBlocked = failedCall.isError === true;
    } catch (error) {
        // A stopped Instance deliberately retracts its tool catalog, so the
        // MCP SDK throws for an unavailable tool rather than returning isError.
        assert.equal(error?.data?.code, "core.toolSchemaUnavailable", String(error));
        offlineBlocked = true;
    }
    assert.equal(offlineBlocked, true, "offline Worker unexpectedly executed bash_run");
    await offlineCall.close();
    runWorker(["start", "--instance", instanceName]);
    workerMayRun = true;
    await waitForReady(fixture.runtime, instanceName);
    client = new Client({ name: "provider-chain-reconnected", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const verify = await callBash(client, ctxId, `wc -c < '${marker}'`);
    assert.equal(verify.exitCode, 0, JSON.stringify(verify));
    assert.match(verify.stdout, /^\s*1\s*$/u);
    await assert.rejects(stat(join(reverseWorkspace, "should-not-run")), { code: "ENOENT" });
    stage("transport interruption produced an error; Worker restart reconnected without replaying or duplicating the side effect");

    await client.close();
    client = undefined;
    runWorker(["stop", "--instance", instanceName]);
    workerMayRun = false;
    const deletion = await withTestspaceControlConnection(
        fixture.runtime,
        async (shared, endpointConnection) =>
            await shared.createInstanceTransport(endpointConnection).deleteInstance(instanceName),
    );
    // Config deletion is committed even when retirement is pending. A
    // compensating public retry is supported; only unresolved old-generation
    // debt is a real failure, not the initial cleanupPending flag alone.
    instanceExists = false;
    let retryFailure;
    if (deletion.cleanupPending) {
        try {
            await withTestspaceControlConnection(fixture.runtime, async (shared, endpointConnection) =>
                await shared.createInstanceTransport(endpointConnection).retryCleanupDebt(instanceName));
        } catch (error) { retryFailure = String(error); }
    }
    const cleanupDebts = await withTestspaceControlConnection(fixture.runtime, async (shared, endpointConnection) =>
        await shared.createInstanceTransport(endpointConnection).listCleanupDebts());
    assert.equal(cleanupDebts.some((entry) => entry.instance === instanceName && entry.state === "pending"), false,
        "Reverse delete cleanup still pending after public retry: " + JSON.stringify({ deletion, retryFailure, cleanupDebts }));
    await assert.rejects(
        readFile(join(fixture.home, ".devshell", "control", "instances", `${instanceName}.toml`), "utf8"),
        { code: "ENOENT" },
    );
    const listAfterDelete = await listInstances(fixture.runtime);
    assert.equal(listAfterDelete.some((entry) => entry.name === instanceName), false);
    stage("Worker stopped, Control deletion settled with cleanupPending=false, and independent instance listing confirms removal");

    const replacement = await withTestspaceControlConnection(
        fixture.runtime,
        async (shared, endpointConnection) => {
            const instances = shared.createInstanceTransport(endpointConnection);
            const result = await instances.createInstance({
                name: instanceName,
                provider: "reverse",
                enabled: true,
                mcp: { enabled: true, auth: "none", contextMode: "explicit" },
                extensions: { model: ["artifact", "instance", "mcp", "secret", "skill"] },
                logs: { eventBufferSize: 100 },
            });
            const code = await shared.createConnectionTransport(endpointConnection).createCode(instanceName);
            return { result, code };
        },
    );
    instanceExists = true;
    assert.equal(replacement.result.name, instanceName);
    assert.notEqual(replacement.code.deviceCode, freshCode.deviceCode);
    workerMayRun = true;
    const reenrolled = runWorker([
        "enroll", "--controller", replacement.code.controllerUrl,
        "--device-code", replacement.code.deviceCode,
    ]);
    assert.equal(reenrolled.status, 0, `${reenrolled.stdout}\n${reenrolled.stderr}`);
    assert.equal(JSON.parse(reenrolled.stdout).connected, true, reenrolled.stdout);
    workerMayRun = true;
    await waitForReady(fixture.runtime, instanceName);
    client = new Client({ name: "provider-chain-recreated", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
    const recreatedEnv = await client.callTool({
        name: "environ_info",
        arguments: { workspace: reverseWorkspace },
    });
    assert.notEqual(recreatedEnv.isError, true, JSON.stringify(recreatedEnv));
    stage("same instance name recreated and a newly issued credential reenrolled the real Worker successfully");

    await client.close();
    client = undefined;
    runWorker(["stop", "--instance", instanceName]);
    workerMayRun = false;
    const finalDelete = await withTestspaceControlConnection(
        fixture.runtime,
        async (shared, endpointConnection) =>
            await shared.createInstanceTransport(endpointConnection).deleteInstance(instanceName),
    );
    assert.equal(finalDelete.cleanupPending, false, JSON.stringify(finalDelete));
    instanceExists = false;
    stage("recreated lifecycle retired with no Control cleanup debt");
} catch (error) {
    primaryFailure = error;
} finally {
    await client?.close().catch(() => undefined);
    const cleanupFailures = [];
    if (workerMayRun) {
        const result = runWorker(["stop", "--instance", instanceName], true);
        if (result.status !== 0) cleanupFailures.push(`${result.stdout}${result.stderr}`);
    }
    if (instanceExists && controlStarted) {
        try {
            await withTestspaceControlConnection(
                fixture.runtime,
                async (shared, endpoint) => {
                    await shared.createInstanceTransport(endpoint).deleteInstance(instanceName);
                },
            );
        } catch (error) {
            cleanupFailures.push(String(error));
        }
    }
    if (controlStarted) {
        const stopped = runCli(["stop"], fixture.env, { allowFailure: true });
        if (stopped.status !== 0) cleanupFailures.push(stopped.stderr || stopped.stdout);
    }
    try {
        await fixture.cleanup();
    } catch (error) {
        cleanupFailures.push(String(error));
    } finally {
        await Promise.all([
            rm(reverseHome, { force: true, recursive: true }),
            rm(reverseRuntime, { force: true, recursive: true }),
        ]).catch((error) => cleanupFailures.push(String(error)));
    }
    if (cleanupFailures.length > 0) {
        primaryFailure = primaryFailure === undefined
            ? new AggregateError(cleanupFailures.map((failure) => new Error(failure)), "Acceptance cleanup failed")
            : new AggregateError([primaryFailure, ...cleanupFailures.map((failure) => new Error(failure))], "Acceptance and cleanup failed");
    }
}
if (primaryFailure !== undefined) throw primaryFailure;

function stage(message) {
    process.stdout.write(`PASS ${message}\n`);
}

function runWorker(args, allowFailure = false) {
    const result = spawnSync(workerPath, args, {
        cwd: reverseWorkspace,
        encoding: "utf8",
        env: workerEnv,
        timeout: 45_000,
        windowsHide: true,
    });
    if (!allowFailure && result.status !== 0) {
        throw new Error(`devshell-worker ${args.join(" ")} exited ${String(result.status)}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
    }
    return result;
}

async function callBash(mcpClient, ctxId, command) {
    const result = await mcpClient.callTool({
        name: "bash_run",
        arguments: { command, ctxId, timeoutMs: 30_000 },
    });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return result.structuredContent ?? {};
}

async function readSnapshot(runtimeDirectory, name) {
    return await withTestspaceControlConnection(runtimeDirectory, async (shared, endpoint) =>
        (await shared.createProcessTransport(endpoint, name).snapshot()).snapshot,
    );
}

async function listInstances(runtimeDirectory) {
    return await withTestspaceControlConnection(runtimeDirectory, async (shared, endpoint) =>
        await shared.createInstanceTransport(endpoint).listInstances(),
    );
}

async function waitForReady(runtimeDirectory, name) {
    await waitForSnapshot(runtimeDirectory, name, (snapshot) =>
        snapshot.ready === true && snapshot.reverse?.transport === "wss",
    );
}

async function waitForOffline(runtimeDirectory, name) {
    await waitForSnapshot(runtimeDirectory, name, (snapshot) =>
        snapshot.reverse?.availability === "offline" || snapshot.ready === false,
    );
}

async function waitForSnapshot(runtimeDirectory, name, predicate) {
    const deadline = Date.now() + 20_000;
    let last;
    while (Date.now() < deadline) {
        try {
            last = await readSnapshot(runtimeDirectory, name);
            if (predicate(last)) return last;
        } catch (error) {
            last = String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${name} snapshot: ${JSON.stringify(last)}`);
}

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdDecompressSync } from "node:zlib";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { resolvePreparedWorker, runCli, workerEnvironmentName } from "../AcceptanceSupport.mjs";
import { withTestspaceControlConnection } from "../../scripts/testspace/TestspaceReverse.mjs";
import { resolveTestspaceTmuxSockets, stopTestspaceTmux } from "../../scripts/testspace/TestspaceRuntime.mjs";

export const instance = "l05-workflow";

async function reservePort() {
    const server = createServer();
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    return port;
}

// AcceptanceFixture equivalent with a dedicated name: no installed instance,
// shared testspace, container engine or production runtime is addressed.
export async function createWorkflowFixture(record) {
    const worker = resolvePreparedWorker();
    const port = await reservePort();
    let webPort = await reservePort();
    while (webPort === port) webPort = await reservePort();
    const root = await mkdtemp(join(tmpdir(), "l05wf-"));
    const home = join(root, "home");
    const runtime = join(root, "run");
    const workspace = join(root, "workspace");
    const devshellHome = join(home, ".devshell");
    await mkdir(join(devshellHome, "control", "instances"), { recursive: true });
    await mkdir(runtime, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(devshellHome, "control", "config.toml"), [
        "version = 2", "[control]", 'logLevel = "info"', "[mcp]", "enabled = true",
        'listenHost = "127.0.0.1"', `listenPort = ${port}`, `publicBaseUrl = "http://127.0.0.1:${port}"`,
        "[web]", "enabled = true", 'listenHost = "127.0.0.1"', `listenPort = ${webPort}`,
        `publicBaseUrl = "http://127.0.0.1:${webPort}"`, 'auth = "none"', "",
    ].join("\n"));
    await writeFile(join(devshellHome, "control", "instances", `${instance}.toml`), [
        "version = 4", `name = "${instance}"`, "enabled = true", 'provider = "local"',
        "[mcp]", "enabled = true", 'auth = "none"', 'contextMode = "explicit"', `path = "/${instance}/mcp"`,
        "[extensions]", 'model = ["artifact", "instance", "mcp", "secret", "skill"]',
        "[logs]", "eventBufferSize = 10000", "",
    ].join("\n"));
    const env = { ...process.env, HOME: home, USERPROFILE: home, LOCALAPPDATA: runtime,
        PORTABLE_DEVSHELL_HOME: devshellHome, XDG_RUNTIME_DIR: runtime,
        XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
        XDG_CACHE_HOME: join(home, ".cache"), [workerEnvironmentName()]: worker };
    for (const name of Object.keys(env)) {
        if (name.startsWith("DEVSHELL_WORKER_INTERNAL_") || name.startsWith("DEVSHELL_TESTSPACE_")) delete env[name];
    }
    const control = (operation) => withTestspaceControlConnection(runtime, operation);
    const cli = (args) => {
        const result = runCli(args, env, { allowFailure: true });
        record("cli", { args, exit: result.status, stdout: result.stdout, stderr: result.stderr });
        assert.equal(result.status, 0, `temporary CLI ${args.join(" ")}: ${result.error ?? ""}\n${result.stdout}${result.stderr}`);
        return result;
    };
    let started = false;
    let previousPid;
    return {
        root, home, runtime, workspace, env, worker, control, cli,
        endpoint: `http://127.0.0.1:${port}/${instance}/mcp`,
        state: join(devshellHome, instance, "control-worker"),
        async start() {
            // Mark before launch so a failed readiness check still tears down our daemon.
            started = true;
            const launch = cli(["start"]);
            assert.match(launch.stdout, /control: running/u);
            const pid = /pid: (\d+)/u.exec(launch.stdout)?.[1];
            assert.ok(pid, "CLI must identify the isolated Control process");
            assert.notEqual(pid, previousPid, "restart reused the previous Control lifetime");
            previousPid = pid;
            record("control-lifetime", { pid });
            cli(["instance", "start", instance]);
            const status = await control((shared, connection) => shared.createProcessTransport(connection, instance).snapshot());
            assert.equal(status.snapshot.ready, true);
        },
        async stop() {
            assert.match(cli(["stop"]).stdout, /control: stopped/u);
        },
        async assertTmuxAlive(marker) {
            const sockets = await resolveTestspaceTmuxSockets({ devshellHome, instanceName: instance, runtimeDirectory: runtime, workspace });
            const matching = [];
            for (const socket of sockets) {
                const panes = spawnSync("tmux", ["-S", socket, "list-panes", "-a", "-F", "#{pane_id} #{pane_dead}"], { env, encoding: "utf8" });
                if (panes.status !== 0) continue;
                for (const row of panes.stdout.trim().split("\n")) {
                    const [pane, dead] = row.split(" ");
                    const capture = spawnSync("tmux", ["-S", socket, "capture-pane", "-p", "-t", pane, "-S", "-100"], { env, encoding: "utf8" });
                    assert.equal(capture.status, 0, capture.stderr);
                    if (capture.stdout.includes(marker)) matching.push({ pane, dead, output: capture.stdout });
                }
            }
            assert.equal(matching.length, 1, "exactly one real tmux pane must contain our start marker");
            assert.equal(matching[0].dead, "0", "stopping Control/Wait must leave the command alive");
            record("tmux-while-control-stopped", matching[0]);
        },
        async cleanup() {
            try {
                if (started) {
                    const stopped = runCli(["stop"], env, { allowFailure: true });
                    record("cleanup-control", { exit: stopped.status, stdout: stopped.stdout, stderr: stopped.stderr });
                    assert.equal(stopped.status, 0, "temporary Control cleanup failed");
                }
            } finally {
                await stopTestspaceTmux({ devshellHome, instanceName: instance, runtimeDirectory: runtime, workspace });
            }
            await rm(root, { force: true, recursive: true });
        },
    };
}

export async function connectWorkflow(fixture) {
    const client = new Client({ name: "round7-L05-workflow", version: "1.0.0" }, { versionNegotiation: { mode: "auto" } });
    await client.connect(new StreamableHTTPClientTransport(new URL(fixture.endpoint)));
    return client;
}

export async function call(client, name, args, timeout = 30000) {
    const result = await client.callTool({ name, arguments: args }, { timeout, maxTotalTimeout: timeout });
    assert.notEqual(result.isError, true, `${name}: ${JSON.stringify(result)}`);
    assert.ok(result.structuredContent && typeof result.structuredContent === "object", `${name} omitted structuredContent`);
    return result;
}

export async function snapshot(client, ctxId) {
    const opened = await call(client, "mcpapp_open", { ctxId });
    const lease = opened._meta?.["portable-devshell/mcpapp"];
    assert.equal(lease?.ctxId, ctxId);
    assert.equal(typeof lease.token, "string");
    const url = new URL(`${lease.liveBaseUrl}/snapshot`);
    url.searchParams.set("ctxId", ctxId);
    assert.equal((await fetch(url, { signal: AbortSignal.timeout(10000) })).status, 401);
    const response = await fetch(url, { headers: { authorization: `Bearer ${lease.token}` }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200, await response.clone().text());
    const result = await response.json();
    assert.equal(result.ctxId, ctxId);
    assert.equal(result.instance, instance);
    return result;
}

export async function eventually(read, accept, label, timeout = 15000) {
    const end = Date.now() + timeout;
    let value;
    do {
        value = await read();
        if (accept(value)) return value;
        await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < end);
    assert.fail(`${label}: ${JSON.stringify(value)}`);
}

export function readWorkflowAudit(fixture) {
    const database = new DatabaseSync(join(fixture.state, "audit.sqlite3"), { readOnly: true });
    try {
        return database.prepare("SELECT collection, payload, body, body_codec FROM audit_records ORDER BY id").all().map((row) => {
            const value = JSON.parse(row.payload);
            if (row.body_codec !== null) {
                assert.equal(row.collection, "logs");
                assert.ok(["identity", "zstd"].includes(row.body_codec), `unknown log codec ${row.body_codec}`);
                value.message = row.body_codec === "zstd" ? zstdDecompressSync(row.body).toString("utf8") : Buffer.from(row.body).toString("utf8");
            }
            return { collection: row.collection, value };
        });
    } finally { database.close(); }
}

export async function readWaitDocument(fixture) {
    return JSON.parse(await readFile(join(fixture.state, "detached-waits.json"), "utf8"));
}

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
    repoRoot, sourceLoader, cliEntry, resolvePreparedWorker, workerEnvironmentName, runCli, readAuditCollections,
} from "../AcceptanceSupport.mjs";

const names = ["l07-artifact-source", "l07-artifact-target"];
const logRoot = resolve(repoRoot, "var/agent-work/beta-matrix-round7/L07-artifact");
const expected = Buffer.from(Array.from({ length: 4000 }, (_, i) =>
    `L07-artifact-${String(i + 1).padStart(6, "0")}\n`).join(""));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

// This fixture deliberately does not use AcceptanceSupport's default instance:
// every command, socket, config and worker is scoped to this fresh HOME.
class ArtifactAcceptanceFixture {
    clients = new Set();
    commands = [];
    touched = false;
    children = new Set();
    paused = new Set();

    async initialize() {
        this.root = await mkdtemp(join(tmpdir(), "l07-artifact-"));
        this.home = join(this.root, "home");
        this.runtime = join(this.root, "runtime");
        this.workspaces = names.map((name) => join(this.root, name));
        this.devshell = join(this.home, ".devshell");
        this.worker = resolvePreparedWorker();
        this.env = {
            ...process.env, HOME: this.home, USERPROFILE: this.home,
            PORTABLE_DEVSHELL_HOME: this.devshell, XDG_RUNTIME_DIR: this.runtime,
            LOCALAPPDATA: this.runtime,
            [workerEnvironmentName()]: this.worker,
        };
        for (const directory of [this.runtime, ...this.workspaces,
            join(this.devshell, "control", "instances")]) {
            await mkdir(directory, { recursive: true });
        }
        this.port = await reservePort();
        this.webPort = await reservePort();
        while (this.webPort === this.port) this.webPort = await reservePort();
        await writeFile(join(this.devshell, "control", "config.toml"), [
            "version = 2", "[control]", 'logLevel = "info"',
            // Exercise the supported Control relay path deterministically.
            "artifactDirectTransfer = false", "[mcp]", "enabled = true",
            'listenHost = "127.0.0.1"', `listenPort = ${this.port}`,
            `publicBaseUrl = "http://127.0.0.1:${this.port}"`,
            "[web]", "enabled = true", 'listenHost = "127.0.0.1"',
            `listenPort = ${this.webPort}`, 'auth = "none"', "",
        ].join("\n"));
        for (const name of names) {
            await writeFile(join(this.devshell, "control", "instances", `${name}.toml`), [
                "version = 4", `name = "${name}"`, "enabled = true", 'provider = "local"',
                "[mcp]", "enabled = true", 'auth = "none"', 'contextMode = "explicit"',
                `path = "/${name}/mcp"`, "[extensions]",
                'model = ["artifact", "instance", "mcp", "secret", "skill"]',
                "[logs]", "eventBufferSize = 100", "",
            ].join("\n"));
        }
    }

    cli(args) {
        assert.equal(this.env.HOME, join(this.root, "home"));
        this.touched = true;
        const result = runCli(args, this.env, { allowFailure: true });
        this.commands.push({ args, exit: result.status, signal: result.signal,
            stdout: result.stdout, stderr: result.stderr, error: result.error?.message });
        assert.equal(result.status, 0,
            `CLI ${args.join(" ")}: ${result.error?.message ?? ""}\n${result.stdout}${result.stderr}`);
        return result.stdout.trim();
    }

    json(args) { return JSON.parse(this.cli(["artifact", ...args])); }

    startCli(args) {
        const child = spawn(process.execPath, ["--import", "tsx", "--import",
            pathToFileURL(sourceLoader).href, cliEntry, ...args], {
            cwd: repoRoot, env: this.env, stdio: ["ignore", "pipe", "pipe"],
        });
        this.children.add(child);
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (data) => { stdout += data; });
        child.stderr.setEncoding("utf8").on("data", (data) => { stderr += data; });
        const completed = new Promise((done) => {
            child.once("error", (error) => { stderr += String(error); });
            child.once("close", (code, signal) => {
                this.children.delete(child);
                const result = { args, exit: code, signal, stdout, stderr };
                this.commands.push(result);
                done(result);
            });
        });
        return { child, completed };
    }

    async connect(index, workspace = this.workspaces[index]) {
        // CLI start and instance start acknowledge a running daemon before the
        // HTTP listener can become observable. Wait for the public MCP route,
        // not a fixed sleep or a hidden internal readiness flag.
        const route = `http://127.0.0.1:${this.port}/${names[index]}/mcp`;
        const deadline = Date.now() + 15_000;
        let last;
        let routeReady = false;
        while (Date.now() < deadline) {
            try {
                const probe = await fetch(route, {
                    method: "POST",
                    headers: { "content-type": "application/json", accept: "application/json, text/event-stream",
                        "mcp-method": "server/discover", "mcp-protocol-version": "2026-07-28" },
                    body: JSON.stringify({ jsonrpc: "2.0", method: "server/discover", id: "acceptance-ready",
                        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28",
                            "io.modelcontextprotocol/clientInfo": { name: "artifact-acceptance-probe", version: "1.0.0" },
                            "io.modelcontextprotocol/clientCapabilities": {} } } }),
                    signal: AbortSignal.timeout(2_000),
                });
                if (probe.ok) { routeReady = true; break; }
                last = `HTTP ${probe.status}: ${(await probe.text()).slice(0, 200)}`;
            } catch (error) { last = String(error); }
            await delay(100);
        }
        if (!routeReady)
            throw new Error(`MCP route for ${names[index]} did not recover after restart: ${last}`);
        const client = new Client({ name: "l07-artifact-acceptance", version: "1.0.0" },
            { versionNegotiation: { mode: "auto" } });
        this.clients.add(client);
        await client.connect(new StreamableHTTPClientTransport(
            new URL(`http://127.0.0.1:${this.port}/${names[index]}/mcp`)));
        const tools = await client.listTools();
        assert.ok(tools.tools.some((tool) => tool.name === "bash_run"));
        const environment = await tool(client, "environ_info", { workspace });
        assert.equal(typeof environment.ctxId, "string");
        assert.notEqual(environment.ctxId, "");
        return { client, ctxId: environment.ctxId };
    }

    async disconnect() {
        for (const client of this.clients) await client.close();
        this.clients.clear();
    }

    async cleanup() {
        const errors = [];
        for (const pid of this.paused) {
            try { process.kill(pid, "SIGCONT"); } catch (error) { errors.push(String(error)); }
        }
        this.paused.clear();
        for (const child of this.children) {
            child.kill("SIGTERM");
            const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
            await new Promise((done) => child.once("close", done));
            clearTimeout(timer);
        }
        for (const client of this.clients) {
            try { await client.close(); } catch (error) { errors.push(String(error)); }
        }
        this.clients.clear();
        if (this.touched) {
            // Use only the prepared binary and fixture environment, including
            // when Control startup failed part way through.
            // Managed local Worker lifecycle belongs to Control. A bare Rust
            // worker stop is self-managed and resolves a different default
            // Instance config; never mistake that for a cleanup failure.
            for (const name of names) {
                const stoppedWorker = runCli(["instance", "stop", name], this.env, { allowFailure: true });
                this.commands.push({ cleanupWorker: name, exit: stoppedWorker.status,
                    stdout: stoppedWorker.stdout, stderr: stoppedWorker.stderr });
                if (stoppedWorker.status !== 0 && !/already stopped|not running|not found|control.*stopped/iu.test(
                    `${stoppedWorker.stdout ?? ""}${stoppedWorker.stderr ?? ""}`))
                    errors.push(`instance cleanup ${name}: ${stoppedWorker.stderr || stoppedWorker.stdout}`);
            }
            const stopped = runCli(["stop"], this.env, { allowFailure: true });
            this.commands.push({ cleanupControl: true, exit: stopped.status,
                stdout: stopped.stdout, stderr: stopped.stderr });
            if (stopped.status !== 0) errors.push(`control cleanup: ${stopped.stderr}`);
        }
        if (this.root) {
            const entries = ["control/logs", ...names.map((name) => `${name}/logs`)];
            for (const entry of entries) {
                const source = join(this.devshell ?? this.root, entry);
                try { await cp(source, join(logRoot, "runtime-logs", entry), { recursive: true }); }
                catch (error) { if (error.code !== "ENOENT") errors.push(String(error)); }
            }
            await rm(this.root, { recursive: true, force: true });
        }
        assert.deepEqual(errors, [], "fixture cleanup failed");
    }
}

async function tool(client, name, args) {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 45_000 });
    assert.equal(result.isError, false, JSON.stringify(result));
    assert.ok(result.structuredContent, `${name} omitted structuredContent`);
    return result.structuredContent;
}

async function bash(context, command) {
    const output = await tool(context.client, "bash_run", {
        ctxId: context.ctxId, command, timeoutMs: 30_000,
    });
    assert.equal(output.exitCode, 0, JSON.stringify(output));
    return output;
}

async function reservePort() {
    const server = createServer();
    await new Promise((done, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", done);
    });
    const port = server.address().port;
    await new Promise((done, reject) => server.close((error) => error ? reject(error) : done()));
    return port;
}

async function jsonFile(path) { return JSON.parse(await readFile(path, "utf8")); }
async function absent(path) {
    await assert.rejects(readFile(path), { code: "ENOENT" });
}

async function terminal(fixture, id) {
    const deadline = Date.now() + 45_000;
    let record;
    do {
        record = fixture.json(["transfer", "status", id]);
        if (["completed", "failed", "cancelled", "interrupted"].includes(record.status)) {
            // Terminal status is published before resource cleanup; wait for the
            // persisted cleanup transaction, rather than racing that transaction.
            const stored = await jsonFile(join(fixture.devshell, "control", "artifacts", "transfers", `${id}.json`));
            if (stored.payloadId === undefined && stored.receiveId === undefined) return record;
        }
        await delay(100);
    } while (Date.now() < deadline);
    assert.fail(`transfer did not terminate: ${JSON.stringify(record)}`);
}

async function download(url, bytes = expected, options = {}) {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
    assert.equal(response.status, options.headers?.Range ? 206 : 200);
    const actual = Buffer.from(await response.arrayBuffer());
    assert.deepEqual(actual, bytes);
    assert.equal(digest(actual), digest(bytes));
}

async function downloadAfterControlRestart(url) {
    // A Node fetch connection pooled before Control stopped may be closed when
    // the original daemon exits. A fresh idempotent GET must still recover the
    // persisted Share after the restart, without weakening its bytes/hash checks.
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            await download(url);
            return;
        } catch (error) {
            if (!(error instanceof TypeError && error.message === "fetch failed") ||
                attempt === 2) throw error;
            await delay(100 * (attempt + 1));
        }
    }
}

export async function runArtifactChain() {
    await mkdir(logRoot, { recursive: true });
    const fixture = new ArtifactAcceptanceFixture();
    const evidence = {
        assignment: "L07-artifact", status: "running", checks: [],
        requiredHost: "Linux with loopback TCP/Unix sockets, signals, /proc, bash, awk, tee, head, sha256sum; prepared real Rust Worker",
        payload: { bytes: expected.length, sha256: digest(expected) },
        gaps: [
            "24-hour Store TTL/quota garbage collection: no public GC/clock API; not forced by editing metadata",
            "direct Worker-to-Worker HTTP transport is not exercised; Control relay is explicitly selected",
            "createShare/startTransfer expose no idempotency key; duplicate transfer is tested as a new rejected operation",
        ],
    };
    let failure;
    try {
        await fixture.initialize();
        fixture.cli(["start"]);
        for (const name of names) fixture.cli(["instance", "start", name]);
        let source = await fixture.connect(0);
        let target = await fixture.connect(1);
        const produced = await bash(source,
            "awk 'BEGIN { for (i=1; i<=4000; i++) printf \"L07-artifact-%06d\\n\", i }' | tee payload.txt");
        assert.equal(produced.stdoutBytes, expected.length);
        assert.equal(produced.stdoutTruncated, true);
        assert.equal(typeof produced.stdoutPath, "string");
        const match = /^\/\.devshell\/tool-results\/([0-9a-f-]+)\/stdout$/u.exec(produced.stdoutPath);
        assert.ok(match, `unexpected retained Artifact path: ${produced.stdoutPath}`);
        const handle = match[1];
        evidence.payload.handle = handle;
        const store = join(fixture.devshell, names[0], "artifacts");
        const metadata = await jsonFile(join(store, `${handle}.json`));
        assert.equal(metadata.handle, handle);
        assert.equal(metadata.storedBytes, expected.length);
        assert.equal(metadata.artifactTruncated, false);
        assert.deepEqual(await readFile(join(store, `${handle}.bin`)), expected);
        assert.match(metadata.blake3, /^[0-9a-f]{64}$/u);
        evidence.payload.blake3 = metadata.blake3;
        evidence.checks.push("MCP SDK -> Control -> source Instance -> Rust bash_run -> durable Artifact Store");

        const share = fixture.json(["share", names[0], `artifact:${handle}`, "--expires-in", "600"]);
        evidence.shareId = share.shareId;
        assert.equal(share.blake3, metadata.blake3);
        assert.equal(share.bytes, expected.length);
        assert.equal(share.state, "active");
        const sharesDir = join(fixture.devshell, "control", "artifacts", "shares");
        const storedShare = await jsonFile(join(sharesDir, `${share.shareId}.json`));
        const payloadFile = join(store, "payloads", `${storedShare.payloadId}.json`);
        const payload = await jsonFile(payloadFile);
        assert.equal(payload.backing.kind, "artifactLease");
        // Serde renames the enum variants, but retains snake_case variant fields.
        const leaseId = payload.backing.lease_id;
        assert.equal(typeof leaseId, "string");
        const leaseFile = join(store, "leases", `${leaseId}.json`);
        assert.equal((await jsonFile(leaseFile)).handle, handle);
        await download(share.url);
        // A bad range must not count as a download or poison the next request.
        const badRange = await fetch(share.url, {
            headers: { Range: `bytes=${expected.length + 1}-` }, signal: AbortSignal.timeout(15_000),
        });
        assert.equal(badRange.status, 416);
        await badRange.arrayBuffer();
        await download(share.url, expected.subarray(17, 49), { headers: { Range: "bytes=17-48" } });
        assert.equal(fixture.json(["shares"]).find((s) => s.shareId === share.shareId).downloadCount, 2);
        evidence.checks.push("Artifact extension share -> durable payload/lease -> HTTP exact bytes/SHA256; bad-range recovery");

        const transferArgs = ["transfer", names[0], `artifact:${handle}`, names[1], "received.txt",
            "--target-workspace", fixture.workspaces[1]];
        const first = await terminal(fixture, fixture.json(transferArgs).transfer.transferId);
        assert.equal(first.status, "completed", JSON.stringify(first));
        assert.equal(first.transferredBytes, expected.length);
        assert.equal(first.payload.payloadBlake3, metadata.blake3);
        await verifyTarget(target, fixture);
        const transferDir = join(fixture.devshell, "control", "artifacts", "transfers");
        assert.equal((await jsonFile(join(transferDir, `${first.transferId}.json`))).record.status, "completed");
        const duplicate = await terminal(fixture, fixture.json(transferArgs).transfer.transferId);
        assert.equal(duplicate.status, "failed", JSON.stringify(duplicate));
        assert.equal(duplicate.failure.code, "artifact.targetExists");
        await verifyTarget(target, fixture);
        const recovered = await terminal(fixture, fixture.json([...transferArgs, "--overwrite"]).transfer.transferId);
        assert.equal(recovered.status, "completed", JSON.stringify(recovered));
        await verifyTarget(target, fixture);
        assert.equal(fixture.json(["transfers"]).length, 3);
        evidence.transfers = [first, duplicate, recovered];
        evidence.checks.push("Artifact CLI -> Control relay -> second Rust Worker receive/commit -> MCP + filesystem checksum");
        evidence.checks.push("duplicate transfer targetExists -> unchanged bytes/no extra file -> explicit overwrite recovery");

        // Gracefully stop both real Workers and Control, retaining only fixture data.
        await fixture.disconnect();
        for (const name of names) fixture.cli(["instance", "stop", name]);
        fixture.cli(["stop"]);
        fixture.cli(["start"]);
        for (const name of names) fixture.cli(["instance", "start", name]);
        source = await fixture.connect(0);
        target = await fixture.connect(1);
        await verifyTarget(target, fixture);
        assert.equal(fixture.json(["transfer", "status", first.transferId]).status, "completed");
        assert.equal(fixture.json(["transfer", "status", duplicate.transferId]).status, "failed");
        assert.equal(fixture.json(["transfers"]).length, 3);
        assert.equal(fixture.json(["shares"]).length, 1);
        await downloadAfterControlRestart(share.url);
        assert.equal(fixture.json(["shares"])[0].downloadCount, 3);
        const reread = await tool(source.client, "file_read", { ctxId: source.ctxId,
            files: [{ path: produced.stdoutPath, view: "content", selector: "2000-2001:raw" }] });
        assert.equal(reread.files[0].content, "2000:L07-artifact-002000\n2001:L07-artifact-002001");
        evidence.checks.push("full fixture Control + both Workers restart -> fresh SDK reconnect -> durable transfer/share/lease + virtual Artifact recovery");

        evidence.cancellation = await cancelAndRecover(fixture, source);
        evidence.checks.push("durable nonzero relay progress -> pause fixture Worker -> public CLI cancel -> resume -> no commit/receive debris -> fresh transfer recovery + independent MCP checksum");

        // Path snapshots have payload-owned bytes: revoke must collect those bytes.
        const snapshot = fixture.json(["share", names[0], "path:./payload.txt", "--workspace", fixture.workspaces[0]]);
        const snapshotRecord = await jsonFile(join(sharesDir, `${snapshot.shareId}.json`));
        const snapshotBase = join(store, "payloads", snapshotRecord.payloadId);
        assert.deepEqual(await readFile(`${snapshotBase}.bin`), expected);
        await download(snapshot.url);
        assert.deepEqual(fixture.json(["revoke", snapshot.shareId]), { revoked: true, shareId: snapshot.shareId });
        await absent(`${snapshotBase}.bin`);
        await absent(`${snapshotBase}.json`);

        assert.deepEqual(fixture.json(["revoke", share.shareId]), { revoked: true, shareId: share.shareId });
        assert.deepEqual(fixture.json(["revoke", share.shareId]), { revoked: true, shareId: share.shareId });
        await absent(payloadFile);
        await absent(leaseFile);
        assert.deepEqual(await readdir(join(store, "leases")), []);
        const closed = await jsonFile(join(sharesDir, `${share.shareId}.json`));
        assert.equal(closed.payloadClosed, true);
        assert.equal(closed.result.state, "revoked");
        for (const url of [share.url, snapshot.url]) {
            const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            assert.equal(response.status, 410);
            await response.arrayBuffer();
        }
        // Revoking a lease must preserve an unexpired underlying Artifact.
        assert.deepEqual(await readFile(join(store, `${handle}.bin`)), expected);
        await verifyTarget(target, fixture);
        assert.equal(fixture.json(["shares"]).filter((s) => s.state === "revoked").length, 2);
        evidence.checks.push("revoke + duplicate revoke -> persisted revoked/payloadClosed -> lease/payload snapshot collection -> HTTP 410; independent destination remains intact");

        for (const name of names) {
            const rows = readAuditCollections(join(fixture.devshell, name, "control-worker", "audit.sqlite3"));
            assert.ok(rows.some((row) => row.collection === "toolCalls" && row.payload.includes('"toolName":"bash_run"')));
            assert.ok(rows.some((row) => row.collection === "events" && row.payload.includes('"type":"toolCall.completed"')));
        }
        evidence.checks.push("independent read-only SQLite toolCall + completion event audit verification on both Instances");
        evidence.status = "passed";
    } catch (error) {
        failure = error;
        const blocked = error.code === "EPERM" && error.syscall === "listen";
        evidence.status = blocked ? "blocked-environment" : "failed";
        evidence.notExercised = blocked
            ? ["Control start", "both Rust Workers", "MCP ingress", "Artifact extension share/transfer/cancel/revoke", "durable state and audit assertions", "restart/reconnect", "lease/payload collection"]
            : ["checks after the reported failure"];
        evidence.error = { name: error.name, code: error.code, syscall: error.syscall, message: error.message };
        await writeFile(join(logRoot, "failure.txt"), error.stack ?? String(error));
        process.exitCode = blocked ? 2 : 1;
    } finally {
        try {
            await fixture.cleanup();
            evidence.cleanup = "passed";
        } catch (error) {
            evidence.cleanup = "failed";
            evidence.cleanupError = error.stack ?? String(error);
            evidence.status = "failed";
            process.exitCode = 1;
        }
        await writeFile(join(logRoot, "commands.json"), JSON.stringify(fixture.commands, null, 2) + "\n");
        await writeFile(join(logRoot, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
        process.stdout.write(JSON.stringify(evidence, null, 2) + "\n");
    }
    return { evidence, failure };
}

async function verifyTarget(context, fixture) {
    // Independent public MCP call on the receiving Worker, plus host-side bytes.
    const checksum = await bash(context, "sha256sum received.txt");
    assert.equal(checksum.stdout.trim(), `${digest(expected)}  received.txt`);
    const content = await tool(context.client, "file_read", { ctxId: context.ctxId,
        files: [{ path: "./received.txt", view: "content", selector: "2000-2001:raw" }] });
    assert.equal(content.files[0].content, "2000:L07-artifact-002000\n2001:L07-artifact-002001");
    assert.deepEqual(await readFile(join(fixture.workspaces[1], "received.txt")), expected);
    await verifyWorkspaceFiles(fixture.workspaces[1], ["received.txt"]);
}

async function verifyWorkspaceFiles(directory, files) {
    // MCP ToolCalls now initialize Context Memory under var/agent-work.
    // Artifact transfers must not leave any other payload files.
    const entries = await readdir(directory);
    assert.deepEqual(entries.filter((name) => name !== "var").sort(), files);
    if (entries.includes("var"))
        assert.deepEqual(await readdir(join(directory, "var")), ["agent-work"]);
}

async function cancelAndRecover(fixture, source) {
    // Linux acceptance intentionally faults only the PID created under this HOME.
    // Watching persisted progress while the native CLI runs avoids a sleep-based
    // guess about when source snapshotting has finished and relay IO has begun.
    assert.equal(process.platform, "linux", "mid-transfer pause fixture requires Linux signals");
    const bytes = 64 * 1024 * 1024;
    await bash(source, `head -c ${bytes} /dev/zero > cancel-source.bin`);
    const destination = join(fixture.root, "cancel-destination");
    await mkdir(destination);
    const context = await fixture.connect(1, destination);
    const directory = join(fixture.devshell, "control", "artifacts", "transfers");
    const before = new Set(await readdir(directory));
    const args = ["artifact", "transfer", names[0], "path:./cancel-source.bin", names[1], "cancelled.bin",
        "--source-workspace", fixture.workspaces[0], "--target-workspace", destination];
    const running = fixture.startCli(args);
    let observed;
    let workerPid;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline && observed === undefined) {
        for (const file of (await readdir(directory)).filter((file) => file.endsWith(".json") && !before.has(file))) {
            const stored = await jsonFile(join(directory, file));
            const record = stored.record;
            assert.notEqual(record.status, "completed", "transfer outran fault injection; no cancellation was exercised");
            assert.notEqual(record.status, "failed", JSON.stringify(record));
            if (record.status === "transferring" && record.transferredBytes > 0 &&
                record.transferredBytes < bytes - 1024 * 1024) {
                workerPid = Number(await readFile(join(fixture.devshell, names[1], "state", "worker.pid"), "utf8"));
                assert.ok(Number.isSafeInteger(workerPid) && workerPid > 1);
                // Validate ownership independently before sending a process signal.
                const environment = await readFile(`/proc/${workerPid}/environ`, "utf8");
                assert.ok(environment.split("\0").includes(`PORTABLE_DEVSHELL_HOME=${fixture.devshell}`));
                process.kill(workerPid, "SIGSTOP");
                fixture.paused.add(workerPid);
                observed = stored;
                break;
            }
        }
        if (observed === undefined) await delay(5);
    }
    assert.ok(observed, "did not observe durable mid-transfer progress before deadline");
    const id = observed.record.transferId;
    try {
        const started = await running.completed;
        assert.equal(started.exit, 0, started.stderr);
        assert.equal(JSON.parse(started.stdout).transfer.transferId, id);
        const cancelled = fixture.json(["transfer", "cancel", id]);
        assert.equal(cancelled.operation, "cancel");
        assert.equal(cancelled.transfer.status, "cancelling");
    } finally {
        process.kill(workerPid, "SIGCONT");
        fixture.paused.delete(workerPid);
    }
    const cancelled = await terminal(fixture, id);
    assert.equal(cancelled.status, "cancelled", JSON.stringify(cancelled));
    assert.ok(cancelled.transferredBytes > 0 && cancelled.transferredBytes < bytes);
    assert.equal(fixture.json(["transfer", "cancel", id]).transfer.status, "cancelled");
    await absent(join(destination, "cancelled.bin"));
    await verifyWorkspaceFiles(destination, []);
    const persisted = await jsonFile(join(directory, `${id}.json`));
    assert.equal(persisted.cancelRequested, true);
    assert.equal(persisted.payloadId, undefined);
    assert.equal(persisted.receiveId, undefined);
    const receives = join(fixture.devshell, names[1], "artifacts", "receives");
    assert.deepEqual(await readdir(receives), []);
    const retry = fixture.json(args.slice(1));
    const completed = await terminal(fixture, retry.transfer.transferId);
    assert.equal(completed.status, "completed", JSON.stringify(completed));
    assert.equal(completed.transferredBytes, bytes);
    const expectedHash = digest(Buffer.alloc(bytes));
    const checksum = await bash(context, "sha256sum cancelled.bin");
    assert.equal(checksum.stdout.trim(), `${expectedHash}  cancelled.bin`);
    assert.equal(digest(await readFile(join(destination, "cancelled.bin"))), expectedHash);
    await verifyWorkspaceFiles(destination, ["cancelled.bin"]);
    assert.equal(fixture.json(["transfers"]).length, 5);
    return { status: "passed", durableProgressBeforePause: observed.record.transferredBytes,
        totalBytes: bytes, retryBytes: completed.transferredBytes, sha256: expectedHash };
}

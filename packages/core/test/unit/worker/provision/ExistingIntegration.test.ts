import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { existingId, replacementId, startedAt } from "./ExistingHarness.ts";

const posix = { skip: process.platform === "win32" ? "requires POSIX provider fixture" : false };
const loader = fileURLToPath(new URL("../../../RegisterWorkspacePackages.mjs", import.meta.url));
const processFixture = fileURLToPath(new URL("./ExistingProcess.ts", import.meta.url));
interface Container { Id: string; State: { Status: string; StartedAt: string }; }

async function fixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), "existing-provider-integration-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const binary = join(root, "fake-provider.mjs");
    await writeFile(binary, `#!${process.execPath}\n${await readFile(new URL("./ExistingCli.mjs", import.meta.url), "utf8")}`, { mode: 0o755 });
    await mkdir(join(root, "container-home"));
    const worker = join(root, "worker.cjs");
    await writeFile(worker, `#!${process.execPath}\nrequire("node:fs").writeSync(1, JSON.stringify({args: process.argv.slice(2)}));\n`, { mode: 0o755 });
    const neighbor: Container = { Id: "c".repeat(64), State: { Status: "running", StartedAt: startedAt } };
    const seed = async (status = "stopped", id = existingId) => writeFile(join(root, "containers.json"), JSON.stringify({ configured: { Id: id, State: { Status: status, StartedAt: startedAt } }, neighbor }));
    await seed();
    await writeFile(join(root, "calls.jsonl"), "");
    const faults = (entries: unknown[]) => writeFile(join(root, "faults.json"), JSON.stringify(entries));
    const calls = async (): Promise<string[][]> => (await readFile(join(root, "calls.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const states = async (): Promise<Record<string, Container>> => JSON.parse(await readFile(join(root, "containers.json"), "utf8"));
    const run = (command: string, tag?: string) => {
        const environment = { ...process.env };
        delete environment.NODE_TEST_CONTEXT;
        const child = spawn(process.execPath, ["--import", "tsx", "--import", loader, processFixture, root, command, ...(tag === undefined ? [] : [tag])], {
            env: {
                ...environment,
                PORTABLE_DEVSHELL_HOME: join(root, "host-state"),
                TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../../../../tsconfig.test.json", import.meta.url)),
                PORTABLE_DEVSHELL_WORKER_LINUX_X64_PATH: worker,
                PORTABLE_DEVSHELL_WORKER_LINUX_ARM64_PATH: worker,
                PORTABLE_DEVSHELL_WORKER_DARWIN_X64_PATH: worker,
                PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH: worker,
            },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        child.stdout.on("data", (chunk) => { stdout += chunk; });
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve({ code, stdout, stderr }));
        });
    };
    return { root, seed, faults, calls, states, run, neighbor };
}

test("Existing integration: full model/factory chain persists adoption across controller processes", posix, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("start")).code, 0);
    const status = await f.run("status");
    assert.equal(status.code, 0, status.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(status.stdout).stdout).args, ["status", "--instance", "adopted"]);
    assert.equal((await f.run("logs")).code, 0);
    assert.equal((await f.run("start")).code, 0);
    assert.equal((await f.calls()).filter(([operation]) => operation === "start").length, 1);
    assert.equal((await f.run("stop")).code, 0);
    assert.equal((await f.states()).configured?.State.Status, "stopped");
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "stop"), [["stop", existingId]]);
    assert.equal((await f.calls()).filter(([operation]) => operation === "exec").every((args) => args.includes(existingId)), true);
    await f.seed("running");
    const refused = await f.run("status");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already running/u);
});

test("Existing integration: changed configuration and replacement container cannot borrow durable identity", posix, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("start")).code, 0);
    const foreignConfig = await f.run("status", "new-config-generation");
    assert.equal(foreignConfig.code, 1);
    assert.match(foreignConfig.stderr, /already running/u);
    assert.equal((await f.run("status")).code, 0);
    await f.seed("running", replacementId);
    const replacement = await f.run("stop");
    assert.equal(replacement.code, 1);
    assert.match(replacement.stderr, /already running/u);
    await f.seed("running");
    assert.equal((await f.run("status")).code, 1, "ID mismatch invalidates the previous marker durably");
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "stop"), []);
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

test("Existing integration: provider start and worker-stop failures recover without false ownership", posix, async (t) => {
    const f = await fixture(t);
    await f.faults([{ operation: "start", code: 37 }]);
    const failedStart = await f.run("start");
    assert.equal(failedStart.code, 1);
    assert.match(failedStart.stderr, /injected start/u);
    assert.equal((await f.states()).configured?.State.Status, "stopped");
    assert.equal((await f.run("start")).code, 0);
    await f.faults([{ operation: "exec", code: 41 }]);
    assert.equal((await f.run("stop")).code, 1);
    assert.equal((await f.states()).configured?.State.Status, "running");
    assert.equal((await f.run("status")).code, 0);
    assert.equal((await f.run("stop")).code, 0);
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

test("Existing integration: cross-process concurrent start excludes a second owner and recovers after lock release", posix, async (t) => {
    const f = await fixture(t);
    await f.faults([{ operation: "start", gate: true }]);
    const first = f.run("start");
    const entered = join(f.root, "gate-entered");
    let gateEntered = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        const content = await readFile(entered, "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
            assert.equal(error.code, "ENOENT");
            return false;
        });
        if (content) { gateEntered = true; break; }
        await setTimeout(10);
    }
    let second;
    try {
        assert.equal(gateEntered, true);
        second = await f.run("start");
    } finally {
        await writeFile(join(f.root, "gate-release"), "");
    }
    assert.equal((await first).code, 0);
    assert.equal(second.code, 1);
    assert.match(second.stderr, /database is locked/u);
    assert.equal((await f.run("status")).code, 0);
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "start"), [["start", existingId]]);
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

test("Existing integration: a name replacement between verification and exec cannot redirect worker execution", posix, async (t) => {
    const f = await fixture(t);
    const foreign = { Id: replacementId, State: { Status: "running", StartedAt: startedAt } };
    await writeFile(join(f.root, "replace-before-exec.json"), JSON.stringify(foreign));
    const started = await f.run("start");
    assert.equal(started.code, 0, started.stderr);
    assert.deepEqual((await f.states()).configured, foreign);
    assert.equal((await f.states()).previous?.Id, existingId);
    assert.equal((await f.calls()).filter(([operation]) => operation === "exec").every((args) => args.includes(existingId)), true);
    const refused = await f.run("stop");
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /already running/u);
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "stop"), []);
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

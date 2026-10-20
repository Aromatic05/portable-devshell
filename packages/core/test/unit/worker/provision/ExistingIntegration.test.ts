import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { ContainerAdoptionStore } from "../../../../src/instance/runtime/provision/container/Adoption.ts";
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
    await writeFile(worker, `#!${process.execPath}
const fs = require("node:fs"), path = require("node:path");
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2), command = args[0], instance = args[2];
const file = path.join(root, "workers.json");
const states = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
fs.appendFileSync(path.join(root, "native.jsonl"), JSON.stringify(args) + "\\n");
const faultsFile = path.join(root, "worker-faults.json");
const faults = fs.existsSync(faultsFile) ? JSON.parse(fs.readFileSync(faultsFile, "utf8")) : [];
const fault = faults.findIndex(value => value.command === command);
if (fault !== -1) {
    const [failure] = faults.splice(fault, 1);
    fs.writeFileSync(faultsFile, JSON.stringify(faults));
    fs.writeSync(2, "injected native " + command + " failure");
    process.exit(failure.code);
}
if (command === "start") states[instance] = "running";
if (command === "stop") states[instance] = "stopped";
if (command === "retire") {
    if (states[instance] === "running" || states[instance] === "stale") {
        fs.writeSync(2, "native retirement rejected stale daemon state");
        process.exit(31);
    }
    delete states[instance];
}
fs.writeFileSync(file, JSON.stringify(states));
fs.writeSync(1, JSON.stringify({args}));
`, { mode: 0o755 });
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
    const record = (name = "adopted") => new ContainerAdoptionStore(join(root, "controller-home", ".devshell", name, "control-worker", "container-adoption.sqlite3")).transaction(async (tx) => tx.read());
    const nativeFaults = (entries: unknown[]) => writeFile(join(root, "worker-faults.json"), JSON.stringify(entries));
    const nativeCalls = async (): Promise<string[][]> => (await readFile(join(root, "native.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { root, seed, faults, calls, states, run, neighbor, record, nativeFaults, nativeCalls };
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

test("Existing integration: unrelated configuration resumes but changed container binding and replacement cannot borrow durable identity", posix, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("start")).code, 0);
    assert.equal((await f.run("status", "new-config-generation")).code, 0);
    const foreignConfig = await f.run("status", "new-container-binding");
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


test("Existing integration: independent instance databases exclude concurrent cross-process starts of one physical ID", posix, async (t) => {
    const f = await fixture(t);
    await f.faults([{ operation: "start", gate: true }]);
    const first = f.run("start");
    let entered = false;
    for (let attempt = 0; attempt < 200; attempt++) {
        entered = await readFile(join(f.root, "gate-entered"), "utf8").then(() => true, (error: NodeJS.ErrnoException) => {
            assert.equal(error.code, "ENOENT");
            return false;
        });
        if (entered) break;
        await setTimeout(10);
    }
    let second;
    try {
        assert.equal(entered, true);
        second = await f.run("start", "second-instance");
    } finally {
        await writeFile(join(f.root, "gate-release"), "");
    }
    const started = await first;
    assert.equal(started.code, 0, started.stderr);
    assert.equal(second.code, 1, second.stderr);
    assert.match(second.stderr, /database is locked/u);
    assert.ok(await f.record());
    assert.equal(await f.record("second"), undefined);
    assert.equal((await f.run("start", "second-instance")).code, 1);
    assert.equal((await f.run("retire-skip", "second-instance")).code, 0);
    assert.equal((await f.run("status")).code, 0);
    assert.deepEqual((await f.calls()).filter(([operation]) => operation === "start"), [["start", existingId]]);
    assert.equal((await f.run("retire-all")).code, 0);
    const next = await f.run("start", "second-instance");
    assert.equal(next.code, 0, next.stderr);
    assert.ok(await f.record("second"));
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

for (const command of ["stop", "retire"]) {
    test(`Existing integration: native ${command} failure retains live SQLite adoption and a fresh process completes retirement`, posix, async (t) => {
        const f = await fixture(t);
        assert.equal((await f.run("start", "worker-only")).code, 0);
        const provenance = await f.record();
        assert.ok(provenance);
        await f.nativeFaults([{ command, code: 23 }]);
        const failed = await f.run("retire-all", "worker-only");
        assert.equal(failed.code, 1);
        assert.match(failed.stderr, /incomplete/u);
        assert.deepEqual(await f.record(), provenance);
        assert.equal((await f.states()).configured?.State.Status, "running");
        assert.equal((await f.run("status", "worker-only")).code, 0);
        const retry = await f.run("retire-all", "worker-only");
        assert.equal(retry.code, 0, retry.stderr);
        assert.equal(await f.record(), undefined);
        assert.equal((await f.run("status", "worker-only")).code, 1);
        assert.deepEqual((await f.states()).neighbor, f.neighbor);
    });
}

test("Existing integration: fresh skip-runtime retirement revokes SQLite provenance and cannot reattach", posix, async (t) => {
    const f = await fixture(t);
    assert.equal((await f.run("start", "worker-only")).code, 0);
    assert.equal((await f.run("retire-skip", "worker-only")).code, 0);
    assert.equal(await f.record(), undefined);
    assert.equal((await f.run("status", "worker-only")).code, 1);
    assert.equal((await f.states()).configured?.State.Status, "running");
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

test("Existing integration: temporary start clears native stale PID and failed physical stop preserves retry provenance", posix, async (t) => {
    const f = await fixture(t);
    await writeFile(join(f.root, "workers.json"), JSON.stringify({ adopted: "stale", neighbor: "running" }));
    await f.faults([{ operation: "stop", code: 47 }]);
    const failed = await f.run("retire-all");
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /incomplete/u);
    const provenance = await f.record();
    assert.ok(provenance);
    assert.equal(provenance.retiring, true);
    assert.deepEqual((await f.nativeCalls()).map(([command]) => command), ["stop", "retire"]);
    assert.equal((await f.states()).configured?.State.Status, "running");
    const retried = await f.run("retire-all");
    assert.equal(retried.code, 0, retried.stderr);
    assert.equal((await f.states()).configured?.State.Status, "stopped");
    assert.equal(await f.record(), undefined);
    assert.deepEqual(JSON.parse(await readFile(join(f.root, "workers.json"), "utf8")), { neighbor: "running" });
    assert.deepEqual((await f.states()).neighbor, f.neighbor);
});

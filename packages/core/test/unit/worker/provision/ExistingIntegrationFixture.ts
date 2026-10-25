import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";
import { ContainerAdoptionStore } from "../../../../src/instance/runtime/provision/container/Adoption.ts";
import { existingId, startedAt } from "./ExistingHarness.ts";

const loader = fileURLToPath(new URL("../../../RegisterWorkspacePackages.mjs", import.meta.url));
const processFixture = fileURLToPath(new URL("./ExistingProcess.ts", import.meta.url));

interface Container { Id: string; State: { Status: string; StartedAt: string }; }

export async function fixture(t: TestContext) {
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


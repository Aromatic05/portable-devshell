import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import type {
    ExtensionAssetCapability,
    ExtensionCapability,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { ExtensionInstanceCapability } from "@portable-devshell/extension/instance";
import type {
    CliNativeCommandInvocationContext,
    CliCommandResult
} from "@portable-devshell/extension/cli";

import { createCliNativeSandboxBinding } from "../../../src/control/cli/CliExtensionSandboxCodec.ts";
import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions
} from "../../../src/control/extension/host/generation/sandbox/ExtensionSandboxHost.ts";
import {
    EXTENSION_SANDBOX_MAX_MESSAGE_BYTES,
    type ExtensionSandboxRegistrationDescriptor
} from "../../../src/control/extension/host/generation/sandbox/ExtensionSandboxProtocol.ts";
import { createWebApplicationSandboxBinding } from "../../../src/server/web/extension/WebApplicationExtensionSandboxCodec.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const noopLogger: ExtensionLogger = {
    debug() {},
    error() {},
    info() {},
    warn() {}
};

const CLI_POINT = "cli.native-commands";
const CLI_ID = "test";

async function setupSandbox(
    t: TestContext,
    name: string,
    source: string,
    options: Omit<Parameters<typeof createSandbox>[0], "codeDirectory" | "entryPath"> = {}
): Promise<ExtensionSandboxHost> {
    const root = await createTestTempDirectory(name);
    const codeDirectory = join(root, "code");
    await mkdir(codeDirectory, { recursive: true });
    const entryPath = join(codeDirectory, "extension.mjs");
    await writeFile(entryPath, source, "utf8");
    const sandbox = createSandbox({ ...options, codeDirectory, entryPath });
    t.after(async () => {
        await sandbox.dispose().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });
    return sandbox;
}

test("Extension sandbox runs in an isolated thread and bridges assets, Worker tools, and progress", async (t) => {
    const calls: string[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox", `
import { threadId } from "node:worker_threads";
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv) => {
        if (argv[0] === "thread") return { kind: "json", value: { id: context.id, threadId } };
        if (argv[0] === "assets") {
            return { kind: "json", value: { bundles: (await context.capabilities.assets.listBundles()).length } };
        }
        if (argv[0] === "tool") {
            const session = await context.capabilities.workers.openSession({ workspace: "/workspace" });
            const progress = [];
            const result = await session.callTool("echo", { text: "hello" }, {
                operationId: "sandbox-op",
                onProgress: (value) => progress.push(value)
            });
            const tools = session.listTools().map((tool) => tool.name);
            await session.close();
            return { kind: "json", value: { progress, result, tools } };
        }
        throw new Error("unknown operation");
    });
}
`, {
        assets: fakeAssets(),
        capabilities: ["assets", "workers"],
        worker: fakeWorker(calls)
    });

    const descriptor = await sandbox.start();
    assert.deepEqual(descriptor.registrations, [{ id: CLI_ID, pointId: CLI_POINT, descriptor: { kind: "command" } }]);
    const thread = await cliJson<{ id: string; threadId: number }>(sandbox, ["thread"], "thread");
    assert.equal(thread.id, "example");
    assert.ok(thread.threadId > 0);
    assert.deepEqual(await cliJson(sandbox, ["assets"], "assets"), { bundles: 1 });
    assert.deepEqual(await cliJson(sandbox, ["tool"], "tool"), {
        progress: [{ phase: "running" }],
        result: { echoed: "hello" },
        tools: ["echo"]
    });
    assert.deepEqual(calls, ["open:/workspace", "call:echo:sandbox-op", "close"]);
});

test("Extension sandbox bridges invocation-scoped CLI I/O", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-cli-io", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (_argv, invocation) => {
        if (!invocation.io) throw new Error("missing CLI I/O");
        await invocation.io.writeStdout("out");
        await invocation.io.writeStderr("err");
        await invocation.io.requestInput({ raw: true });
        const input = await invocation.io.readInput();
        return { kind: "text", text: input === undefined ? "eof" : Buffer.from(input).toString("utf8") };
    });
}
`);
    await sandbox.start();
    const calls: string[] = [];
    const result = await sandboxCliCommand(sandbox, CLI_ID, [], {
        ...invocation("cli-io"),
        io: {
            async readInput() {
                calls.push("read");
                return Buffer.from("input");
            },
            async requestInput(options) {
                calls.push(`request:${options?.raw === true}`);
            },
            async writeStderr(chunk) {
                calls.push(`stderr:${chunk}`);
            },
            async writeStdout(chunk) {
                calls.push(`stdout:${chunk}`);
            }
        }
    });
    assert.deepEqual(result, { kind: "text", text: "input" });
    assert.deepEqual(calls, ["stdout:out", "stderr:err", "request:true", "read"]);
});

test("Extension sandbox bridges declared Artifact and Instance management capabilities", async (t) => {
    const calls: string[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-management-capabilities", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const instances = await context.capabilities.instances.list();
        const shares = await context.capabilities.artifacts.listShares();
        const snapshot = await context.capabilities.instances.snapshot("local-test");
        return { kind: "json", value: {
            instanceNames: instances.map((value) => value.name),
            shareIds: shares.map((value) => value.shareId),
            status: snapshot.status
        } };
    });
}
`, {
        artifacts: fakeArtifacts(calls),
        capabilities: ["artifacts", "instances"],
        instances: fakeInstances(calls)
    });

    await sandbox.start();
    assert.deepEqual(await cliJson(sandbox, [], "management-capabilities"), {
        instanceNames: ["local-test"],
        shareIds: ["share-1"],
        status: "ready"
    });
    assert.deepEqual(calls, ["instances.list", "artifacts.listShares", "instances.snapshot:local-test"]);
});

test("Extension sandbox loads the public CLI SDK leaf without exposing other portable-devshell internals", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-public-sdk", `
import { nativeCommands } from "@portable-devshell/extension/cli";
export function activate(context) {
    context.register(nativeCommands, "test", async () => ({ kind: "text", text: nativeCommands.id }));
}
`);
    await sandbox.start();
    assert.equal(await cliText(sandbox, [], "public-sdk"), "cli.native-commands");
});

test("Extension code cannot forge sandbox protocol messages through worker_threads parentPort", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-private-port", `
import { parentPort } from "node:worker_threads";
parentPort?.postMessage({ descriptor: { registrations: [{ id: "forged", pointId: "cli.native-commands", descriptor: { kind: "command" } }] }, type: "ready" });
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => ({ kind: "text", text: "actual" }));
}
`);
    const descriptor = await sandbox.start();
    assert.deepEqual(descriptor.registrations, [{ id: CLI_ID, pointId: CLI_POINT, descriptor: { kind: "command" } }]);
    assert.equal(await cliText(sandbox, [], "actual"), "actual");
});

test("Extension code cannot break sandbox replies by replacing MessagePort.prototype.postMessage", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-messageport-prototype", `
import { MessagePort } from "node:worker_threads";
const original = MessagePort.prototype.postMessage;
export function activate(context) {
    MessagePort.prototype.postMessage = function () { throw new Error("forged postMessage"); };
    context.register({ id: "cli.native-commands" }, "test", async () => ({ kind: "text", text: "actual" }));
}
export function deactivate() { MessagePort.prototype.postMessage = original; }
`);
    await sandbox.start();
    assert.equal(await cliText(sandbox, [], "prototype"), "actual");
});

test("Extension sandbox blocks process signals that would terminate Control", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-process-signal", `
import { kill as namedKill } from "node:process";
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv) => {
        if (argv[0] === "probe") return { kind: "json", value: process.kill(process.pid, 0) };
        if (argv[0] === "named") return { kind: "json", value: namedKill === process.kill };
        if (argv[0] === "self") return { kind: "json", value: process.kill(process.pid, "SIGTERM") };
        if (argv[0] === "group") return { kind: "json", value: process.kill(0, "SIGTERM") };
        return { kind: "text", text: "alive" };
    });
}
`);
    await sandbox.start();
    assert.equal(await cliJson(sandbox, ["probe"], "probe"), true);
    assert.equal(await cliJson(sandbox, ["named"], "named"), true);
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["self"], invocation("self")), /cannot signal the Control process/u);
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["group"], invocation("group")), /cannot signal the Control process/u);
    assert.equal(await cliText(sandbox, ["alive"], "alive"), "alive");
});

test("Extension sandbox denies raw child processes even when the managed processes capability is granted", async (t) => {
    const processCalls: string[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-child-process", `
import { spawnSync } from "node:child_process";
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv) => {
        if (argv[0] === "raw") {
            try {
                const result = spawnSync(process.execPath, ["-e", "process.stdout.write('child-ok')"], { encoding: "utf8" });
                if (result.error) throw result.error;
                return { kind: "json", value: { allowed: true, stdout: result.stdout } };
            } catch (error) {
                return { kind: "json", value: { allowed: false, code: error?.code, message: error?.message } };
            }
        }
        const managed = await context.capabilities.processes.start({ command: "managed-test" });
        await managed.terminate();
        return { kind: "text", text: "managed" };
    });
}
`, {
        capabilities: ["processes"],
        processes: fakeProcesses(processCalls)
    });
    await sandbox.start();
    const raw = await cliJson<{ allowed: boolean; code?: string; message?: string }>(sandbox, ["raw"], "raw-child");
    assert.equal(raw.allowed, false);
    assert.match(raw.message ?? "", /child process|permission|allow-child-process/i);
    assert.equal(await cliText(sandbox, ["managed"], "managed-process"), "managed");
    assert.deepEqual(processCalls, ["start:managed-test", "terminate:SIGTERM"]);
});

test("Extension sandbox denies nested Workers so resource limits cannot be bypassed", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-nested-worker", `
import { Worker } from "node:worker_threads";
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        try {
            const worker = new Worker("setInterval(() => {}, 1000)", { eval: true });
            await worker.terminate();
            return { kind: "json", value: { allowed: true } };
        } catch (error) {
            return { kind: "json", value: { allowed: false, code: error?.code, message: error?.message } };
        }
    });
}
`);
    await sandbox.start();
    const result = await cliJson<{ allowed: boolean; code?: string; message?: string }>(sandbox, [], "nested-worker");
    assert.equal(result.allowed, false);
    assert.match(result.message ?? "", /allow-worker/u);
});

test("Extension sandbox denies unaccounted shared-memory primitives", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-shared-memory", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        let sharedWasm;
        try { new WebAssembly.Memory({ initial: 1, maximum: 2, shared: true }); sharedWasm = "allowed"; }
        catch (error) { sharedWasm = error.message; }
        let vmImport;
        try { await import("node:vm"); vmImport = "allowed"; }
        catch (error) { vmImport = error.message; }
        let builtinVm;
        try { process.getBuiltinModule?.("node:vm"); builtinVm = "allowed"; }
        catch (error) { builtinVm = error.message; }
        const normalWasm = new WebAssembly.Memory({ initial: 1 });
        return { kind: "json", value: {
            builtinVm,
            normalWasmBytes: normalWasm.buffer.byteLength,
            sharedArrayBuffer: typeof SharedArrayBuffer,
            sharedWasm,
            vmImport
        } };
    });
}
`);
    await sandbox.start();
    const result = await cliJson<Record<string, unknown>>(sandbox, [], "shared-memory");
    assert.equal(result.sharedArrayBuffer, "undefined");
    assert.match(String(result.sharedWasm), /does not allow shared WebAssembly memory/u);
    assert.match(String(result.vmImport), /(restricted module|does not allow builtin module) node:vm/u);
    assert.match(String(result.builtinVm), /(restricted module|does not allow builtin module) node:vm/u);
    assert.equal(result.normalWasmBytes, 64 * 1024);
});

test("Extension sandbox preserves structured error code without leaking private causes", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-error-transport", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const error = new Error("sandbox operation failed");
        error.code = "instance_invalid";
        error.cause = new Error("private sandbox cause");
        throw error;
    });
}
`);
    await sandbox.start();
    await assert.rejects(
        sandboxCliCommand(sandbox, CLI_ID, [], invocation("structured-error")),
        (error: unknown) => {
            if (!(error instanceof Error)) return false;
            assert.equal((error as Error & { code?: string }).code, "instance_invalid");
            assert.equal(error.message, "sandbox operation failed");
            assert.equal(error.cause, undefined);
            assert.doesNotMatch(error.stack ?? "", /private sandbox cause/u);
            return true;
        }
    );
});

test("Extension sandbox reports runtime faults even when Extension code handles uncaughtException", async (t) => {
    const faults: Error[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-runtime-fault", `
export function activate(context) {
    process.on("uncaughtException", () => {});
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const session = await context.capabilities.workers.openSession({ workspace: "/workspace" });
        await session.callTool("echo", { text: "hello" }, {
            onProgress: () => { throw new Error("runtime fault escaped handler"); }
        });
        return { kind: "text", text: "unreachable" };
    });
}
`, {
        capabilities: ["workers"],
        onFault: (error) => faults.push(error),
        worker: fakeWorker([])
    });
    await sandbox.start();
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, [], invocation("runtime-fault")), /runtime fault escaped handler/u);
    await waitFor(() => faults.length === 1);
    assert.match(faults[0]!.message, /runtime fault escaped handler/u);
});

test("Extension sandbox rejects cyclic, binary, and oversized messages before structured clone", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-message-budget", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv) => {
        if (argv[0] === "alive") return { kind: "text", text: "alive" };
        if (argv[0] === "binary") return { kind: "json", value: Buffer.alloc(1024) };
        if (argv[0] === "cycle") { const value = {}; value.self = value; return { kind: "json", value }; }
        if (argv[0] === "huge") return { kind: "text", text: "x".repeat(${EXTENSION_SANDBOX_MAX_MESSAGE_BYTES + 1024}) };
        return { kind: "text", text: argv[1] ?? "" };
    });
}
`);
    await sandbox.start();
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["cycle"], invocation("cycle")), /cyclic object graph/u);
    assert.equal(await cliText(sandbox, ["alive"], "after-cycle"), "alive");
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["binary"], invocation("binary")), /non-plain object/u);
    assert.equal(await cliText(sandbox, ["alive"], "after-binary"), "alive");
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["huge"], invocation("huge")), /sandbox message limit/u);
    assert.equal(await cliText(sandbox, ["alive"], "after-huge"), "alive");
    const oversizedInput = "y".repeat(EXTENSION_SANDBOX_MAX_MESSAGE_BYTES + 1024);
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["echo", oversizedInput], invocation("oversized-input")), /sandbox message limit/u);
    assert.equal(await cliText(sandbox, ["alive"], "after-oversized-input"), "alive");
});

test("Extension progress callback failure faults only the sandbox worker", async (t) => {
    const faults: Error[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-progress-fault", `
process.on("uncaughtException", () => {});
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const session = await context.capabilities.workers.openSession({ workspace: "/workspace" });
        await session.callTool("echo", { text: "hello" }, {
            onProgress: () => { throw new Error("progress exploded"); }
        });
        return { kind: "text", text: "unreachable" };
    });
}
`, {
        capabilities: ["workers"],
        onFault: (error) => faults.push(error),
        worker: fakeWorker([])
    });
    await sandbox.start();
    await assert.rejects(
        Promise.race([
            sandboxCliCommand(sandbox, CLI_ID, [], invocation("progress")),
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("sandbox runtime fault was not reported")), 500))
        ]),
        /progress exploded|worker exited unexpectedly/u
    );
    await waitFor(() => faults.length === 1);
    assert.equal(faults.length, 1);
});

test("Extension sandbox escalates ignored cancellation to worker termination", async (t) => {
    const faults: Error[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-cancel", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv, invocation) => {
        if (argv[0] === "cooperative") {
            await new Promise((_resolve, reject) => invocation.signal.addEventListener("abort", () => reject(invocation.signal.reason), { once: true }));
            return { kind: "text", text: "unreachable" };
        }
        if (argv[0] === "late") {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { kind: "text", text: "late" };
        }
        await new Promise(() => {});
        return { kind: "text", text: "unreachable" };
    });
}
`, {
        invocationAbortGraceMs: 50,
        onFault: (error) => faults.push(error)
    });
    await sandbox.start();

    const cooperativeController = new AbortController();
    const cooperative = sandboxCliCommand(sandbox, CLI_ID, ["cooperative"], {
        ...invocation("cooperative"), signal: cooperativeController.signal
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    cooperativeController.abort(new TypeError("caller cancelled"));
    await assert.rejects(cooperative, (error: unknown) => error instanceof TypeError && error.message === "caller cancelled");
    assert.equal(faults.length, 0);

    const lateController = new AbortController();
    const late = sandboxCliCommand(sandbox, CLI_ID, ["late"], { ...invocation("late"), signal: lateController.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    lateController.abort(new Error("late result cancelled"));
    await assert.rejects(late, /late result cancelled/u);
    assert.equal(faults.length, 0);

    const controller = new AbortController();
    const pending = sandboxCliCommand(sandbox, CLI_ID, ["hang"], { ...invocation("hang"), signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancel test"));
    await assert.rejects(pending, /did not stop after cancellation/u);
    assert.equal(faults.length, 1);
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, ["hang"], invocation("after-fault")), /did not stop after cancellation/u);
});

test("Extension sandbox memory limit terminates only the sandbox worker", { timeout: 15_000 }, async (t) => {
    const faults: Error[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-memory", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const retained = [];
        for (;;) retained.push(new Array(1_000_000).fill(Math.random()));
    });
}
`, {
        onFault: (error) => faults.push(error),
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
    });
    await sandbox.start();
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, [], invocation("memory")), /memory|heap|worker|allocation|terminated/i);
    assert.equal(faults.length, 1);
    assert.equal(typeof process.pid, "number");
});

test("Extension sandbox watchdog terminates runaway Buffer external memory", { timeout: 15_000 }, async (t) => {
    const faults: Error[] = [];
    const sandbox = await setupSandbox(t, "extension-sandbox-external-memory", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const retained = [];
        for (;;) {
            retained.push(Buffer.alloc(4 * 1024 * 1024, 1));
            await new Promise((resolve) => setTimeout(resolve, 5));
        }
    });
}
`, {
        externalMemoryLimitMb: 24,
        memoryWatchIntervalMs: 10,
        onFault: (error) => faults.push(error),
        resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 2 }
    });
    await sandbox.start();
    await assert.rejects(sandboxCliCommand(sandbox, CLI_ID, [], invocation("external-memory")), /external memory exceeded 24 MiB/u);
    assert.equal(faults.length, 1);
});

test("Extension sandbox cancellation aborts an in-flight asset projection", async (t) => {
    let projectionAborted = false;
    const assets: ExtensionAssetCapability = {
        ...fakeAssets(),
        async projectBundle(input) {
            return await new Promise((_resolve, reject) => {
                const signal = input.signal;
                if (signal === undefined) {
                    reject(new Error("projection signal missing"));
                    return;
                }
                const abort = () => {
                    projectionAborted = true;
                    reject(signal.reason);
                };
                if (signal.aborted) abort();
                else signal.addEventListener("abort", abort, { once: true });
            });
        }
    };
    const sandbox = await setupSandbox(t, "extension-sandbox-asset-abort", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async (argv, invocation) => {
        if (argv[0] === "alive") return { kind: "text", text: "alive" };
        await context.capabilities.assets.projectBundle({
            generation: "sha256-a",
            signal: invocation.signal,
            target: { collection: "skills", instance: "local", key: "demo" }
        });
        return { kind: "text", text: "projected" };
    });
}
`, { assets, capabilities: ["assets"] });
    await sandbox.start();
    const controller = new AbortController();
    const pending = sandboxCliCommand(sandbox, CLI_ID, ["project"], {
        ...invocation("asset-abort"),
        signal: controller.signal
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancel projection"));
    await assert.rejects(pending, /cancel projection/u);
    await waitFor(() => projectionAborted);
    assert.equal(await cliText(sandbox, ["alive"], "after-asset-abort"), "alive");
});

test("Extension sandbox closes a Worker session that finishes opening after the sandbox faults", async (t) => {
    let releaseOpen!: () => void;
    const openGate = new Promise<void>((resolve) => { releaseOpen = resolve; });
    let closed = 0;
    const worker: ExtensionWorkerCapability = {
        async openSession(input): Promise<ExtensionWorkerSession> {
            await openGate;
            let resolveClosed!: () => void;
            const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
            let isClosed = false;
            return {
                closed: closedPromise,
                environment: { homeDirectory: "/home/test", platform: { arch: "x64", os: "linux" } },
                instance: "local-test",
                workspace: input.workspace,
                async callTool() { return {}; },
                async close() {
                    if (isClosed) return;
                    isClosed = true;
                    closed += 1;
                    resolveClosed();
                },
                listTools: () => []
            };
        }
    };
    const sandbox = await setupSandbox(t, "extension-sandbox-session-race", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        await context.capabilities.workers.openSession({ workspace: "/race" });
        return { kind: "text", text: "opened" };
    });
}
`, {
        capabilities: ["workers"],
        invocationAbortGraceMs: 50,
        worker
    });
    t.after(() => releaseOpen());
    await sandbox.start();
    const controller = new AbortController();
    const pending = sandboxCliCommand(sandbox, CLI_ID, [], { ...invocation("open-race"), signal: controller.signal });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancel open"));
    await assert.rejects(pending, /did not stop after cancellation/u);
    releaseOpen();
    await waitFor(() => closed === 1);
    assert.equal(closed, 1);
});

test("Extension sandbox preserves an already-closed managed process across the start-result race", async (t) => {
    const processes: ExtensionProcessCapability = {
        async start(): Promise<ExtensionManagedProcess> {
            return {
                closed: Promise.resolve({ code: 7 }),
                onMessage: () => () => undefined,
                onStderr: () => () => undefined,
                async send() {},
                async terminate() {}
            };
        }
    };
    const sandbox = await setupSandbox(t, "extension-sandbox-process-close-race", `
export function activate(context) {
    context.register({ id: "cli.native-commands" }, "test", async () => {
        const process = await context.capabilities.processes.start({ command: "already-closed" });
        const exit = await process.closed;
        return { kind: "json", value: exit };
    });
}
`, { capabilities: ["processes"], processes });
    await sandbox.start();
    assert.deepEqual(await cliJson(sandbox, [], "process-close-race"), { code: 7 });
});

test("Extension sandbox preserves Web files bindings through the Web-owned descriptor codec", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-web-files", `
export function activate(context) {
    context.register({ id: "web.applications" }, "test", {
        source: { directory: "web", kind: "files" }
    });
}
`);
    const descriptor = await sandbox.start();
    assert.deepEqual(descriptor.registrations, [{
        descriptor: { directory: "web", kind: "files" },
        id: "test",
        pointId: "web.applications"
    }]);
    const registration = await sandboxRegistration(sandbox, "web.applications", "test");
    const binding = createWebApplicationSandboxBinding(
        registration.descriptor,
        sandboxPointContext("test"),
        sandbox
    );
    assert.deepEqual(binding, {
        source: { directory: "web", kind: "files" }
    });
});

test("Extension sandbox bounds host-driven Web application endpoint resolution", async (t) => {
    const sandbox = await setupSandbox(t, "extension-sandbox-web-timeout", `
export function activate(context) {
    context.register({ id: "web.applications" }, "test", {
        source: { kind: "endpoint", resolve: async () => await new Promise(() => {}) }
    });
}
`, { hostCallbackTimeoutMs: 50 });
    const descriptor = await sandbox.start();
    assert.deepEqual(descriptor.registrations, [{ id: "test", pointId: "web.applications", descriptor: { kind: "endpoint" } }]);
    await assert.rejects(sandboxWebEndpoint(sandbox, "test"), /Web application endpoint resolution timed out/u);
});

function createSandbox(options: {
    artifacts?: ExtensionArtifactCapability;
    assets?: ExtensionAssetCapability;
    capabilities?: readonly ExtensionCapability[];
    codeDirectory: string;
    entryPath: string;
    externalMemoryLimitMb?: number;
    hostCallbackTimeoutMs?: number;
    invocationAbortGraceMs?: number;
    instances?: ExtensionInstanceCapability;
    memoryWatchIntervalMs?: number;
    onFault?: (error: Error) => void;
    processes?: ExtensionProcessCapability;
    resourceLimits?: ExtensionSandboxHostOptions["resourceLimits"];
    worker?: ExtensionWorkerCapability;
}): ExtensionSandboxHost {
    const root = join(options.codeDirectory, "..", "runtime");
    return new ExtensionSandboxHost({
        artifacts: options.artifacts ?? fakeArtifacts([]),
        assets: options.assets ?? fakeAssets(),
        capabilities: options.capabilities ?? [],
        codeDirectory: options.codeDirectory,
        context: {
            generation: "g1",
            id: "example",
            paths: {
                codeDirectory: options.codeDirectory,
                dataDirectory: join(root, "data"),
                runtimeDirectory: join(root, "run"),
                stateDirectory: join(root, "state")
            },
            version: "1.0.0"
        },
        entryUrl: pathToFileURL(options.entryPath).href,
        ...(options.externalMemoryLimitMb === undefined ? {} : { externalMemoryLimitMb: options.externalMemoryLimitMb }),
        ...(options.hostCallbackTimeoutMs === undefined ? {} : { hostCallbackTimeoutMs: options.hostCallbackTimeoutMs }),
        ...(options.invocationAbortGraceMs === undefined ? {} : { invocationAbortGraceMs: options.invocationAbortGraceMs }),
        instances: options.instances ?? fakeInstances([]),
        logger: noopLogger,
        ...(options.memoryWatchIntervalMs === undefined ? {} : { memoryWatchIntervalMs: options.memoryWatchIntervalMs }),
        ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
        processes: options.processes ?? fakeProcesses([]),
        ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
        worker: options.worker ?? fakeWorker([])
    });
}

function fakeArtifacts(calls: string[]): ExtensionArtifactCapability {
    return {
        async cancelTransfer(transferId) {
            calls.push(`artifacts.cancelTransfer:${transferId}`);
            throw new Error("unused fake Artifact transfer");
        },
        async createShare() {
            calls.push("artifacts.createShare");
            throw new Error("unused fake Artifact share creation");
        },
        async getTransfer(transferId) {
            calls.push(`artifacts.getTransfer:${transferId}`);
            throw new Error("unused fake Artifact transfer");
        },
        async listShares() {
            calls.push("artifacts.listShares");
            return [{
                blake3: "b3",
                bytes: 1,
                downloadName: "demo.txt",
                expiresAtMs: 1,
                mediaType: "text/plain",
                shareId: "share-1",
                source: { handle: "artifact-1", instance: "local-test" },
                state: "active",
                url: "http://example.invalid/share"
            }];
        },
        async listTransfers() {
            calls.push("artifacts.listTransfers");
            return [];
        },
        async revokeShare(shareId) {
            calls.push(`artifacts.revokeShare:${shareId}`);
            return { revoked: true, shareId };
        },
        async startTransfer() {
            calls.push("artifacts.startTransfer");
            throw new Error("unused fake Artifact transfer");
        },
        async waitForTransfer(transferId) {
            calls.push(`artifacts.waitForTransfer:${transferId}`);
            throw new Error("unused fake Artifact transfer");
        }
    };
}

function fakeInstances(calls: string[]): ExtensionInstanceCapability {
    const snapshot = {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 4,
        name: "local-test",
        ready: true,
        status: "ready" as const
    };
    return {
        async create() { throw new Error("unused fake Instance create"); },
        async createSchema() { return {}; },
        async delete(name) { calls.push(`instances.delete:${name}`); },
        async disable(name) { calls.push(`instances.disable:${name}`); },
        async enable(name) { calls.push(`instances.enable:${name}`); },
        async list() {
            calls.push("instances.list");
            return [{ enabled: true, mcpEnabled: true, name: "local-test", provider: "local", snapshot }];
        },
        async readLogs(name) {
            calls.push(`instances.readLogs:${name}`);
            return [];
        },
        async refresh(name) {
            calls.push(`instances.refresh:${name}`);
            return snapshot;
        },
        async snapshot(name) {
            calls.push(`instances.snapshot:${name}`);
            return snapshot;
        },
        async start(name) {
            calls.push(`instances.start:${name}`);
            return snapshot;
        },
        async stop(name) {
            calls.push(`instances.stop:${name}`);
            return snapshot;
        },
        async validateCreate() { return {}; },
        async watchEvents() {}
    };
}

function fakeAssets(): ExtensionAssetCapability {
    return {
        async installBundle() { return { directory: "/bundle", generation: "sha256-a" }; },
        async installDirectory() { return { directory: "/bundle", generation: "sha256-a" }; },
        async listBundles() { return [{ directory: "/bundle", generation: "sha256-a" }]; },
        async projectBundle() { return { transferId: "transfer", transferredBytes: 1 }; },
        async removeBundle() {},
        async resolveBundle() { return { directory: "/bundle", generation: "sha256-a" }; }
    };
}

function fakeProcesses(calls: string[]): ExtensionProcessCapability {
    return {
        async start(input): Promise<ExtensionManagedProcess> {
            calls.push(`start:${input.command}`);
            let resolveClosed!: (exit: ExtensionProcessExit) => void;
            const closed = new Promise<ExtensionProcessExit>((resolve) => { resolveClosed = resolve; });
            let terminated = false;
            return {
                closed,
                onMessage: () => () => undefined,
                onStderr: () => () => undefined,
                async send() {},
                async terminate(signal = "SIGTERM") {
                    if (terminated) return;
                    terminated = true;
                    calls.push(`terminate:${signal}`);
                    resolveClosed({ signal });
                }
            };
        }
    };
}

function fakeWorker(calls: string[]): ExtensionWorkerCapability {
    return {
        async openSession(input): Promise<ExtensionWorkerSession> {
            calls.push(`open:${input.workspace}`);
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
            let isClosed = false;
            return {
                closed,
                environment: {
                    homeDirectory: "/home/test",
                    platform: { arch: "x64", os: "linux" }
                },
                instance: input.instance ?? "local-test",
                workspace: input.workspace,
                async callTool(toolName, toolInput, options = {}): Promise<ExtensionJsonValue> {
                    calls.push(`call:${toolName}:${options.operationId ?? ""}`);
                    options.signal?.throwIfAborted();
                    options.onProgress?.({ phase: "running" });
                    return { echoed: (toolInput as { text: string }).text };
                },
                async close() {
                    if (isClosed) return;
                    isClosed = true;
                    calls.push("close");
                    resolveClosed();
                },
                listTools: () => [{
                    description: "echo",
                    inputSchema: { type: "object" },
                    name: "echo"
                }]
            };
        }
    };
}

function invocation(requestId: string): CliNativeCommandInvocationContext {
    return {
        localOwner: true,
        requestId,
        signal: new AbortController().signal
    };
}

async function sandboxCliCommand(
    sandbox: ExtensionSandboxHost,
    id: string,
    argv: readonly string[],
    context: CliNativeCommandInvocationContext
): Promise<CliCommandResult> {
    const registration = await sandboxRegistration(sandbox, CLI_POINT, id);
    const binding = createCliNativeSandboxBinding(registration.descriptor, sandboxPointContext(id), sandbox);
    return await binding(argv, context);
}

async function sandboxWebEndpoint(
    sandbox: ExtensionSandboxHost,
    id: string
): Promise<URL | undefined> {
    const registration = await sandboxRegistration(sandbox, "web.applications", id);
    const binding = createWebApplicationSandboxBinding(
        registration.descriptor,
        sandboxPointContext(id),
        sandbox
    );
    if (binding.source.kind !== "endpoint") {
        throw new TypeError(`Expected endpoint-backed Web application ${id}.`);
    }
    return await binding.source.resolve();
}

async function sandboxRegistration(
    sandbox: ExtensionSandboxHost,
    pointId: string,
    id: string
): Promise<ExtensionSandboxRegistrationDescriptor> {
    const registration = (await sandbox.start()).registrations.find((candidate) =>
        candidate.pointId === pointId && candidate.id === id
    );
    assert.ok(registration, `Missing sandbox registration ${pointId}/${id}.`);
    return registration;
}

function sandboxPointContext(id: string) {
    return Object.freeze({
        codeDirectory: "/sandbox-test",
        extensionId: "example",
        id
    });
}

async function cliJson<T = unknown>(sandbox: ExtensionSandboxHost, argv: readonly string[], requestId: string): Promise<T> {
    const result = await sandboxCliCommand(sandbox, CLI_ID, argv, invocation(requestId));
    assert.equal(result.kind, "json");
    return result.value as T;
}

async function cliText(sandbox: ExtensionSandboxHost, argv: readonly string[], requestId: string): Promise<string> {
    const result = await sandboxCliCommand(sandbox, CLI_ID, argv, invocation(requestId));
    assert.equal(result.kind, "text");
    return result.text;
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for sandbox test condition.");
}

import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import type {
    ExtensionAssetCapability,
    ExtensionJsonValue,
    ExtensionLogger,
    ExtensionWorkerCapability,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions
} from "../../../src/control/extension/host/generation/sandbox/ExtensionSandboxHost.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const noopLogger: ExtensionLogger = {
    debug() {},
    error() {},
    info() {},
    warn() {}
};

test("Extension sandbox runs in an isolated thread and bridges assets, Worker tools, and progress", async (t) => {
    const root = await createTestTempDirectory("extension-sandbox");
    const codeDirectory = join(root, "code");
    await mkdir(codeDirectory, { recursive: true });
    const entryPath = join(codeDirectory, "extension.mjs");
    await writeFile(entryPath, [
        "import { threadId } from 'node:worker_threads';",
        "export async function activate(context) {",
        "  return {",
        "    rpc: {",
        "      thread: async () => ({ id: context.id, threadId }),",
        "      assets: async () => ({ bundles: (await context.assets.listBundles()).length }),",
        "      tool: async (_input, invocation) => {",
        "        const session = await context.worker.openSession({ workspace: '/workspace' });",
        "        const progress = [];",
        "        const result = await session.callTool('echo', { text: 'hello' }, {",
        "          signal: invocation.signal,",
        "          operationId: 'sandbox-op',",
        "          onProgress: (value) => progress.push(value)",
        "        });",
        "        const tools = session.listTools().map((tool) => tool.name);",
        "        await session.close();",
        "        return { progress, result, tools };",
        "      }",
        "    },",
        "    dispose() {}",
        "  };",
        "}",
        ""
    ].join("\n"), "utf8");
    const calls: string[] = [];
    const sandbox = createSandbox({
        assets: fakeAssets(),
        codeDirectory,
        entryPath,
        worker: fakeWorker(calls)
    });
    t.after(async () => {
        await sandbox.dispose().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });

    const descriptor = await sandbox.start();
    assert.deepEqual(descriptor.rpc, ["assets", "thread", "tool"]);
    const thread = await sandbox.rpc("thread", undefined, invocation("thread")) as {
        id: string;
        threadId: number;
    };
    assert.equal(thread.id, "example");
    assert.ok(thread.threadId > 0);
    assert.deepEqual(await sandbox.rpc("assets", undefined, invocation("assets")), { bundles: 1 });
    assert.deepEqual(await sandbox.rpc("tool", undefined, invocation("tool")), {
        progress: [{ phase: "running" }],
        result: { echoed: "hello" },
        tools: ["echo"]
    });
    assert.deepEqual(calls, ["open:/workspace", "call:echo:sandbox-op", "close"]);
});

test("Extension sandbox escalates ignored cancellation to worker termination", async (t) => {
    const root = await createTestTempDirectory("extension-sandbox-cancel");
    const codeDirectory = join(root, "code");
    await mkdir(codeDirectory, { recursive: true });
    const entryPath = join(codeDirectory, "extension.mjs");
    await writeFile(entryPath, [
        "export async function activate() {",
        "  return {",
        "    rpc: {",
        "      cooperative: async (_input, invocation) => await new Promise((_resolve, reject) => {",
        "        invocation.signal.addEventListener('abort', () => reject(invocation.signal.reason), { once: true });",
        "      }),",
        "      hang: async () => await new Promise(() => {})",
        "    },",
        "    dispose() {}",
        "  };",
        "}",
        ""
    ].join("\n"), "utf8");
    const faults: Error[] = [];
    const sandbox = createSandbox({
        codeDirectory,
        entryPath,
        invocationAbortGraceMs: 50,
        onFault: (error) => faults.push(error)
    });
    t.after(async () => {
        await sandbox.dispose().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });
    await sandbox.start();
    const cooperativeController = new AbortController();
    const cooperative = sandbox.rpc("cooperative", undefined, {
        ...invocation("cooperative"),
        signal: cooperativeController.signal
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    cooperativeController.abort(new TypeError("caller cancelled"));
    await assert.rejects(
        cooperative,
        (error: unknown) => error instanceof TypeError && error.message === "caller cancelled"
    );
    assert.equal(faults.length, 0);

    const controller = new AbortController();
    const pending = sandbox.rpc("hang", undefined, {
        ...invocation("hang"),
        signal: controller.signal
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort(new Error("cancel test"));

    await assert.rejects(pending, /did not stop after cancellation/u);
    assert.equal(faults.length, 1);
    await assert.rejects(
        sandbox.rpc("hang", undefined, invocation("after-fault")),
        /did not stop after cancellation/u
    );
});

test("Extension sandbox memory limit terminates only the sandbox worker", { timeout: 15_000 }, async (t) => {
    const root = await createTestTempDirectory("extension-sandbox-memory");
    const codeDirectory = join(root, "code");
    await mkdir(codeDirectory, { recursive: true });
    const entryPath = join(codeDirectory, "extension.mjs");
    await writeFile(entryPath, [
        "export async function activate() {",
        "  return {",
        "    rpc: {",
        "      consume: async () => {",
        "        const retained = [];",
        "        for (;;) retained.push(new Array(1_000_000).fill(Math.random()));",
        "      }",
        "    },",
        "    dispose() {}",
        "  };",
        "}",
        ""
    ].join("\n"), "utf8");
    const faults: Error[] = [];
    const sandbox = createSandbox({
        codeDirectory,
        entryPath,
        onFault: (error) => faults.push(error),
        resourceLimits: {
            maxOldGenerationSizeMb: 32,
            maxYoungGenerationSizeMb: 8,
            stackSizeMb: 2
        }
    });
    t.after(async () => {
        await sandbox.dispose().catch(() => undefined);
        await rm(root, { force: true, recursive: true });
    });
    await sandbox.start();

    await assert.rejects(
        sandbox.rpc("consume", undefined, invocation("memory")),
        /memory|heap|worker|allocation|terminated/i
    );
    assert.equal(faults.length, 1);
    assert.equal(typeof process.pid, "number");
});

function createSandbox(options: {
    assets?: ExtensionAssetCapability;
    codeDirectory: string;
    entryPath: string;
    invocationAbortGraceMs?: number;
    onFault?: (error: Error) => void;
    resourceLimits?: ExtensionSandboxHostOptions["resourceLimits"];
    worker?: ExtensionWorkerCapability;
}): ExtensionSandboxHost {
    const root = join(options.codeDirectory, "..", "runtime");
    return new ExtensionSandboxHost({
        assets: options.assets ?? fakeAssets(),
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
        ...(options.invocationAbortGraceMs === undefined ? {} : {
            invocationAbortGraceMs: options.invocationAbortGraceMs
        }),
        logger: noopLogger,
        ...(options.onFault === undefined ? {} : { onFault: options.onFault }),
        ...(options.resourceLimits === undefined ? {} : { resourceLimits: options.resourceLimits }),
        worker: options.worker ?? fakeWorker([])
    });
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

function fakeWorker(calls: string[]): ExtensionWorkerCapability {
    return {
        async openSession(input): Promise<ExtensionWorkerSession> {
            calls.push(`open:${input.workspace}`);
            return {
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
                async close() { calls.push("close"); },
                listTools: () => [{
                    description: "echo",
                    inputSchema: { type: "object" },
                    name: "echo"
                }]
            };
        }
    };
}

function invocation(requestId: string): ExtensionInvocationContextLike {
    return {
        localOwner: true,
        requestId,
        signal: new AbortController().signal
    };
}

type ExtensionInvocationContextLike = Parameters<ExtensionSandboxHost["rpc"]>[2];

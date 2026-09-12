import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessCapability,
    ExtensionProcessExit,
    ExtensionProcessStartInput
} from "@portable-devshell/extension";

import type { AgentToolSession } from "../../src/builtin/provider/AgentToolSession.ts";
import { parseAgentWorkerTarget } from "../../src/builtin/worker/AgentWorkerTarget.ts";
import { OpenCodeAgentProcessFactory } from "../../src/provider/opencode/OpenCodeAgentProcess.ts";

const childModulePath = join(dirname(fileURLToPath(import.meta.url)), "../fixtures/FakeOpenCodeAgentChild.mjs");

test("OpenCode process uses the provider-neutral Agent tool input and result projection", async () => {
    const runtimeDirectory = await mkdtemp(join(tmpdir(), "devshell-opencode-tools-"));
    const target = parseAgentWorkerTarget("worker-a:/repo/tools");
    const calls: Array<{ input: ExtensionJsonValue; operationId: string; toolName: string }> = [];
    const tools: AgentToolSession = {
        closed: new Promise<void>(() => undefined),
        modelTools: [{
            description: "Apply edits",
            inputSchema: { type: "object", properties: { operations: { type: "array" } } },
            name: "file_edit"
        }],
        target,
        tools: [{
            description: "Apply edits",
            inputSchema: { type: "object", properties: { operations: { type: "array" } } },
            name: "file_edit"
        }],
        async callTool(toolName, input, operationId) {
            calls.push({ input, operationId, toolName });
            return {
                operations: [{
                    action: "patch",
                    addedLines: 1,
                    diff: "large provider-internal diff must not reach the model",
                    path: "./demo.txt",
                    removedLines: 1,
                    status: "applied"
                }]
            };
        },
        async close() {}
    };
    const factory = new OpenCodeAgentProcessFactory({ childModulePath });

    try {
        const handle = await factory.start({
            agentId: "ag-opencode-tools",
            command: "/private/opencode",
            localCwd: join(runtimeDirectory, "agents", "ag-opencode-tools", "cwd"),
            processes: nodeProcessCapability(),
            stateDirectory: runtimeDirectory,
            target,
            tools
        });
        await handle.prompt("__file-edit__");
        await handle.waitForIdle?.();
        await handle.stop();

        assert.deepEqual(calls, [{
            input: { operations: [], resultDetail: "diff" },
            operationId: "fake-file-edit-operation",
            toolName: "file_edit"
        }]);
        const log = (await readFile(join(runtimeDirectory, "fake-opencode-child.log"), "utf8"))
            .trim().split("\n").map((line) => JSON.parse(line));
        assert.equal(log[0]?.command, "/private/opencode");
        assert.equal(log[1]?.result, "patch ./demo.txt applied +1 -1");
        assert.doesNotMatch(log[1]?.result ?? "", /provider-internal diff/u);
    } finally {
        await rm(runtimeDirectory, { force: true, recursive: true });
    }
});

function nodeProcessCapability(): ExtensionProcessCapability {
    return {
        async start(input: ExtensionProcessStartInput): Promise<ExtensionManagedProcess> {
            const child = spawn(input.command, [...(input.args ?? [])], {
                cwd: input.cwd,
                env: { ...process.env, ...(input.environment ?? {}) },
                serialization: "json",
                stdio: input.messages ? ["ignore", "ignore", "pipe", "ipc"] : ["ignore", "ignore", "pipe"]
            });
            const messageListeners = new Set<(message: ExtensionJsonValue) => void>();
            const stderrListeners = new Set<(chunk: string) => void>();
            let settled = false;
            let resolveClosed!: (exit: ExtensionProcessExit) => void;
            const closed = new Promise<ExtensionProcessExit>((resolve) => { resolveClosed = resolve; });
            const settle = (exit: ExtensionProcessExit) => {
                if (settled) return;
                settled = true;
                resolveClosed(Object.freeze({ ...exit }));
            };
            child.stderr?.setEncoding("utf8");
            child.stderr?.on("data", (chunk: string) => {
                for (const listener of stderrListeners) listener(chunk);
            });
            child.on("message", (message: unknown) => {
                for (const listener of messageListeners) listener(message as ExtensionJsonValue);
            });
            child.once("error", () => settle({}));
            child.once("exit", (code, signal) => settle({
                ...(code === null ? {} : { code }),
                ...(signal === null ? {} : { signal })
            }));
            return Object.freeze({
                closed,
                onMessage(listener: (message: ExtensionJsonValue) => void) {
                    messageListeners.add(listener);
                    return () => messageListeners.delete(listener);
                },
                onStderr(listener: (chunk: string) => void) {
                    stderrListeners.add(listener);
                    return () => stderrListeners.delete(listener);
                },
                async send(message: ExtensionJsonValue) {
                    if (!child.connected || child.send === undefined) throw new Error("Test child IPC is unavailable.");
                    await new Promise<void>((resolve, reject) => {
                        child.send!(message as never, (error) => error === null ? resolve() : reject(error));
                    });
                },
                async terminate(signal = "SIGTERM") {
                    if (settled) return;
                    child.kill(signal as NodeJS.Signals);
                    await closed;
                }
            });
        }
    };
}

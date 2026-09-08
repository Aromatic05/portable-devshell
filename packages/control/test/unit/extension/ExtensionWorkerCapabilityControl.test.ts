import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import {
    ExtensionWorkerCapabilityControl,
    resolveExtensionWorkerInstance
} from "../../../src/control/extension/ExtensionWorkerCapabilityControl.ts";

test("Extension worker instance selection prefers one enabled local instance", () => {
    assert.equal(resolveExtensionWorkerInstance([
        { enabled: true, name: "remote-a", provider: "ssh" },
        { enabled: true, name: "local-a", provider: "local" }
    ]), "local-a");
    assert.equal(resolveExtensionWorkerInstance([
        { enabled: true, name: "remote-a", provider: "ssh" }
    ]), "remote-a");
    assert.equal(resolveExtensionWorkerInstance([
        { enabled: true, name: "remote-a", provider: "ssh" },
        { enabled: true, name: "remote-b", provider: "ssh" }
    ], "remote-b"), "remote-b");
    assert.throws(() => resolveExtensionWorkerInstance([]), /No enabled/u);
    assert.throws(() => resolveExtensionWorkerInstance([
        { enabled: true, name: "a", provider: "ssh" },
        { enabled: true, name: "b", provider: "reverse" }
    ]), /Multiple enabled/u);
});

test("Extension worker session uses the audited WorkerInstance call path and generic attribution", async () => {
    const calls: Array<{
        context: ToolCallContext;
        input: JsonValue;
        onProgress?: (progress: JsonValue) => void;
        signal?: AbortSignal;
        toolName: string;
    }> = [];
    const released: Array<{ instance: string; reference: string }> = [];
    const closedToolSessions: string[] = [];
    const worker = {
        handshake: {
            capabilities: { cancel: true, streaming: true, tools: true },
            homeDirectory: "/home/dev",
            instance: "local",
            platform: {
                arch: "x64",
                distribution: { id: "arch", name: "Arch Linux" },
                os: "linux",
                packageManager: "pacman",
                shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
            },
            protocolVersion: 5,
            workerVersion: "0.7.0"
        },
        async callTool(
            toolName: string,
            input: JsonValue,
            context: ToolCallContext,
            signal?: AbortSignal,
            _transformResult?: unknown,
            _invocationInput?: JsonValue,
            onProgress?: (progress: JsonValue) => void
        ) {
            calls.push({ context, input, onProgress, signal, toolName });
            onProgress?.({ phase: "running" });
            return { ok: true };
        },
        listTools() {
            return [{
                description: "Read a file",
                inputSchema: { type: "object" },
                name: "file_read",
                outputSchema: {},
                requiredCapabilities: []
            }];
        },
        async prepareWorkspace(workspace: string) {
            assert.equal(workspace, "/requested");
            return {
                projectMemoryAgentFile: "/canonical/AGENTS.md",
                projectMemoryDirectory: "/canonical",
                temporaryDirectory: "/tmp/devshell",
                workspace: "/canonical"
            };
        },
        async releaseToolSession(sessionId: string) {
            closedToolSessions.push(sessionId);
        }
    };
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        connections: {
            async acquire(instance, reference) {
                assert.equal(instance, "local");
                assert.match(reference, /^extension-worker:example:g1:ext-/u);
                return { handle: {} as never, snapshot: {} as never, worker: worker as never };
            },
            async release(instance, reference) {
                released.push({ instance, reference });
            }
        },
        extensionId: "example",
        generation: "g1",
        instances: {
            list: () => [{ enabled: true, name: "local", provider: "local" }]
        } as never
    });
    const session = await capability.openSession({ workspace: "/requested" });

    assert.equal(session.instance, "local");
    assert.equal(session.workspace, "/canonical");
    assert.deepEqual(session.environment, {
        homeDirectory: "/home/dev",
        platform: {
            arch: "x64",
            distribution: { id: "arch", name: "Arch Linux" },
            os: "linux",
            packageManager: "pacman",
            shell: { executable: "/bin/bash", kind: "bash", version: "5.3" }
        },
    });
    assert.deepEqual(session.listTools(), [{
        description: "Read a file",
        inputSchema: { type: "object" },
        name: "file_read"
    }]);
    const controller = new AbortController();
    const progress: JsonValue[] = [];
    assert.deepEqual(await session.callTool("file_read", { path: "./README.md" }, {
        onProgress: (value) => progress.push(value),
        operationId: "operation-1",
        signal: controller.signal
    }), { ok: true });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.toolName, "file_read");
    assert.deepEqual(calls[0]?.input, { path: "./README.md" });
    assert.equal(calls[0]?.signal, controller.signal);
    assert.equal(calls[0]?.context.source, "extension");
    assert.equal(calls[0]?.context.extensionId, "example");
    assert.equal(calls[0]?.context.operationId, "operation-1");
    assert.equal(calls[0]?.context.requestId, "operation-1");
    assert.equal(calls[0]?.context.workspace, "/canonical");
    assert.match(calls[0]?.context.ctxId ?? "", /^ext-/u);
    assert.deepEqual(progress, [{ phase: "running" }]);

    await session.close();
    await session.close();
    assert.equal(closedToolSessions.length, 1);
    assert.equal(released.length, 1);
    assert.equal(released[0]?.instance, "local");
});

test("Extension worker capability refuses undeclared access before acquiring an instance", async () => {
    let acquired = false;
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: false,
        connections: {
            async acquire() {
                acquired = true;
                throw new Error("must not acquire");
            },
            async release() {}
        },
        extensionId: "example",
        generation: "g1",
        instances: { list: () => [] } as never
    });
    await assert.rejects(capability.openSession({ workspace: "/repo" }), /did not declare/u);
    assert.equal(acquired, false);
});

test("Extension worker instance retirement closes only matching sessions", async () => {
    const releases: string[] = [];
    const workers = new Map<string, {
        handshake: {
            capabilities: { cancel: boolean; streaming: boolean; tools: boolean };
            homeDirectory: string;
            instance: string;
            platform: { arch: string; os: string };
            protocolVersion: number;
            workerVersion: string;
        };
        callTool(): Promise<JsonValue>;
        listTools(): never[];
        prepareWorkspace(workspace: string): Promise<{ projectMemoryAgentFile: string; projectMemoryDirectory: string; temporaryDirectory: string; workspace: string }>;
        releaseToolSession(sessionId: string): Promise<void>;
    }>();
    for (const instance of ["one", "two"]) {
        workers.set(instance, {
            handshake: {
                capabilities: { cancel: true, streaming: true, tools: true },
                homeDirectory: `/${instance}/home`,
                instance,
                platform: { arch: "x64", os: "linux" },
                protocolVersion: 5,
                workerVersion: "0.7.0"
            },
            async callTool() { return {}; },
            listTools() { return []; },
            async prepareWorkspace(workspace) {
                return {
                    projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                    projectMemoryDirectory: workspace,
                    temporaryDirectory: `${workspace}/tmp`,
                    workspace
                };
            },
            async releaseToolSession() {}
        });
    }
    const capability = new ExtensionWorkerCapabilityControl({
        allowed: true,
        connections: {
            async acquire(instance) {
                return { handle: {} as never, snapshot: {} as never, worker: workers.get(instance)! as never };
            },
            async release(instance) {
                releases.push(instance);
            }
        },
        extensionId: "example",
        generation: "g1",
        instances: {
            list: () => [
                { enabled: true, name: "one", provider: "ssh" },
                { enabled: true, name: "two", provider: "ssh" }
            ]
        } as never
    });
    const one = await capability.openSession({ instance: "one", workspace: "/one" });
    const two = await capability.openSession({ instance: "two", workspace: "/two" });

    await capability.retireInstance("one");
    assert.deepEqual(releases, ["one"]);
    await one.close();
    assert.deepEqual(releases, ["one"]);

    await capability.closeAll();
    assert.deepEqual(releases, ["one", "two"]);
    await two.close();
    assert.deepEqual(releases, ["one", "two"]);
});

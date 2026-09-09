import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import test from "node:test";

import {
    WorkerBinary,
    WorkerInstanceFactory,
    WorkerTransportDriverLocal
} from "@portable-devshell/core/testing";
import { McpHost } from "@portable-devshell/mcp/testing";
import { asInstanceName, type JsonValue } from "@portable-devshell/shared";
import { executeInstanceCommand } from "@portable-devshell/instance-extension";
import type { CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

import { CliExtensionCommandService } from "../../src/control/cli/CliExtensionCommandService.ts";
import { ModelDevshellBroker } from "../../src/control/cli/ModelDevshellBroker.ts";
import { ExtensionInstanceCapabilityControl } from "../../src/control/extension/host/generation/capability/ExtensionInstanceCapabilityControl.ts";
import type { InstanceDescriptor } from "../../src/control/instance/InstanceDescriptor.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import { RuntimeSubscriptionManager } from "../../src/instance/runtime/RuntimeSubscriptionManager.ts";
import {
    commandAvailable,
    realWorkerTestOptions,
    resolveTestWorkerBinary
} from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { requireTcpPort } from "../../../../test/TestHttpSupport.ts";

const workerBinaryPath = resolveTestWorkerBinary();

interface TestRpcResponse {
    error?: JsonValue;
    result?: {
        isError?: boolean;
        protocolVersion?: string;
        structuredContent?: {
            ctxId?: string;
            exitCode?: number;
            output?: JsonValue[];
            stderr?: string;
            stdout?: string;
            task?: { id?: string; status?: string };
        };
    };
}

test(
    "MCP bash_run resolves model devshell through the Worker shim without builtin fallback",
    realWorkerTestOptions(workerBinaryPath),
    async () => {
        const instanceName = "model-devshell-real";
        const homeDirectory = await createTestTempDirectory("model-devshell-home");
        const workspace = await createTestTempDirectory("model-devshell-workspace");
        const worker = new WorkerInstanceFactory().create({
            env: { ...process.env, HOME: homeDirectory },
            homeDirectory,
            name: asInstanceName(instanceName),
            transport: new WorkerTransportDriverLocal({
                spawnFunction: spawn,
                workerBinary: new WorkerBinary(workerBinaryPath!)
            })
        });
        const descriptor = {
            enabled: true,
            mcpEnabled: true,
            mcpPath: `/${instanceName}/mcp`,
            modelExtensions: ["instance"],
            name: instanceName,
            provider: "local",
            todo: {
                summaries: () => []
            },
            worker
        } as unknown as InstanceDescriptor;
        const instances = new InstanceRegistry([descriptor]);
        const host = new McpHost({
            instances: [{
                auth: { enabled: false, provider: "none" },
                name: instanceName,
                worker
            }],
            listenHost: "127.0.0.1",
            listenPort: 0
        });
        const commands = new CliExtensionCommandService(instanceModelExtensionHost(instances, instanceName), {
            surface: "model"
        });
        const broker = new ModelDevshellBroker({
            access: { allows: ({ extensionId }) => extensionId === "instance" },
            commands,
            contextAdmin: () => host.contextAdmin,
            instances
        });

        try {
            await worker.start();
            await host.start();
            const endpoint = `http://127.0.0.1:${requireTcpPort(host.server.address)}/${instanceName}/mcp`;
            const initialize = await postJson(endpoint, {
                id: "initialize",
                jsonrpc: "2.0",
                method: "initialize",
                params: {
                    capabilities: {},
                    clientInfo: { name: "model-devshell-test", version: "1" },
                    protocolVersion: "2025-06-18"
                }
            });
            assert.equal(initialize.error, undefined, JSON.stringify(initialize));
            const headers = {
                "mcp-protocol-version": String(initialize.result?.protocolVersion ?? "")
            };
            await postRaw(endpoint, {
                jsonrpc: "2.0",
                method: "notifications/initialized"
            }, headers);
            const ctxId = await createContext(endpoint, headers, workspace);

            const status = await callBash(
                endpoint,
                headers,
                ctxId,
                `devshell instance status ${instanceName}`
            );
            assert.equal(status.error, undefined, JSON.stringify(status));
            assert.equal(status.result?.isError, false, JSON.stringify(status));
            assert.equal(status.result?.structuredContent?.exitCode, 0);
            assert.match(
                String(status.result?.structuredContent?.stdout ?? ""),
                new RegExp(`instance: ${instanceName}\\nstatus: ready`, "u")
            );

            const forbidden = await callBash(endpoint, headers, ctxId, "devshell stop");
            assert.equal(forbidden.error, undefined, JSON.stringify(forbidden));
            assert.equal(forbidden.result?.isError, false, JSON.stringify(forbidden));
            assert.equal(forbidden.result?.structuredContent?.exitCode, 127);
            assert.match(
                String(forbidden.result?.structuredContent?.stderr ?? ""),
                /CLI command stop is unavailable\./u
            );

            const stillAlive = await callBash(
                endpoint,
                headers,
                ctxId,
                `devshell instance status ${instanceName}`
            );
            assert.equal(stillAlive.result?.structuredContent?.exitCode, 0);

            if (process.platform !== "win32" && commandAvailable("tmux", ["-V"])) {
                const tmux = await callTool(endpoint, headers, "tmux_run", {
                    command: `devshell instance status ${instanceName}`,
                    ctxId,
                    line: 80,
                    timeout: 30_000,
                    wait: "block"
                });
                assert.equal(tmux.error, undefined, JSON.stringify(tmux));
                assert.equal(tmux.result?.isError, false, JSON.stringify(tmux));
                assert.equal(tmux.result?.structuredContent?.task?.status, "0");
                assert.match(
                    String((tmux.result?.structuredContent?.output ?? []).join("\n")),
                    new RegExp(`instance: ${instanceName}`, "u")
                );

                const delayed = await callTool(endpoint, headers, "tmux_run", {
                    command: `sleep 0.4; devshell instance status ${instanceName}`,
                    ctxId,
                    line: 0,
                    wait: "nonblock"
                });
                assert.equal(delayed.error, undefined, JSON.stringify(delayed));
                assert.equal(delayed.result?.isError, false, JSON.stringify(delayed));
                const delayedTask = delayed.result?.structuredContent?.task?.id;
                assert.ok(typeof delayedTask === "string", JSON.stringify(delayed));
                await new Promise((resolve) => setTimeout(resolve, 600));
                const delayedRead = await callTool(endpoint, headers, "tmux_read", {
                    ctxId,
                    line: -80,
                    task: delayedTask,
                    timeMs: 3_000
                });
                assert.equal(delayedRead.error, undefined, JSON.stringify(delayedRead));
                assert.equal(delayedRead.result?.isError, false, JSON.stringify(delayedRead));
                assert.match(
                    String((delayedRead.result?.structuredContent?.output ?? []).join("\n")),
                    new RegExp(`instance: ${instanceName}`, "u")
                );
            }
        } finally {
            broker.dispose();
            await host.stop().catch(() => undefined);
            await worker.stop().catch(() => undefined);
            await worker.close().catch(() => undefined);
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(workspace, { force: true, recursive: true });
        }
    }
);

async function createContext(
    endpoint: string,
    headers: Record<string, string>,
    workspace: string
): Promise<string> {
    const response = await postJson(endpoint, {
        id: "environ",
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
            arguments: { workspace },
            name: "environ_info"
        }
    }, headers);
    const ctxId = response.result?.structuredContent?.ctxId;
    assert.ok(typeof ctxId === "string", JSON.stringify(response));
    return ctxId;
}

async function callBash(
    endpoint: string,
    headers: Record<string, string>,
    ctxId: string,
    command: string
) {
    return await callTool(endpoint, headers, "bash_run", { command, ctxId, timeoutMs: 30_000 });
}

async function callTool(
    endpoint: string,
    headers: Record<string, string>,
    name: string,
    args: Record<string, JsonValue>
) {
    return await postJson(endpoint, {
        id: `${name}-${Date.now()}-${Math.random()}`,
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
            arguments: args,
            name
        }
    }, headers);
}

function instanceModelExtensionHost(instances: InstanceRegistry, instanceName: string) {
    const capability = new ExtensionInstanceCapabilityControl({
        allowed: true,
        create: {
            async createInstance() { throw new Error("not used"); },
            getSchema() { return {} as never; },
            validateDraft() { return {} as never; }
        },
        editor: {
            async deleteInstance() { throw new Error("not used"); },
            async disableInstance() { throw new Error("not used"); },
            async enableInstance() { throw new Error("not used"); }
        },
        extensionId: "instance",
        instances,
        listConfigured: () => [{ enabled: true, mcpEnabled: true, name: instanceName, provider: "local" }],
        subscriptions: new RuntimeSubscriptionManager()
    });
    const declaration = {
        id: "instance",
        summary: "Inspect portable-devshell instances",
        title: "Instance",
        usage: "instance <command>"
    };
    return {
        async acquireRegistration(pointId: string, id: string) {
            assert.equal(pointId, "cli.model-commands");
            assert.equal(id, "instance");
            return {
                lease: { release() {} },
                registration: {
                    binding: async (argv: readonly string[], invocation: CliModelCommandInvocationContext) =>
                        await executeInstanceCommand(capability, argv, invocation),
                    declaration,
                    id,
                    pointId
                }
            } as never;
        },
        listDeclarations(pointId: string) {
            if (pointId !== "cli.model-commands") return [];
            return [{
                declaration,
                extensionId: "instance",
                generation: "test",
                id: "instance",
                pointId
            }];
        }
    } as never;
}

async function postJson(
    url: string,
    body: JsonValue,
    extraHeaders: Record<string, string> = {}
): Promise<TestRpcResponse> {
    const response = await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders
        },
        method: "POST"
    });
    const text = await response.text();
    assert.equal(response.ok, true, text);
    if (text.length === 0) return {};
    const data = text
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6));
    return JSON.parse(data.at(-1) ?? text) as TestRpcResponse;
}

async function postRaw(
    url: string,
    body: JsonValue,
    extraHeaders: Record<string, string>
): Promise<Response> {
    return await fetch(url, {
        body: JSON.stringify(body),
        headers: {
            accept: "application/json, text/event-stream",
            "content-type": "application/json",
            ...extraHeaders
        },
        method: "POST"
    });
}

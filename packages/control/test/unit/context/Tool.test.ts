import assert from "node:assert/strict";
import test from "node:test";

import type { ToolCallHooks } from "@portable-devshell/core/toolcall";
import { mcpTools } from "@portable-devshell/mcp/tool";
import type { InstanceName, JsonValue } from "@portable-devshell/shared";

import {
    contextToolDefinitions,
    installContextTools,
    type ContextApi,
} from "@portable-devshell/core/context";

test("Context owns environ tool definitions with structured environment output", () => {
    const definitions = contextToolDefinitions();
    assert.deepEqual(
        definitions.map((definition) => definition.name),
        ["environ_info", "environ_remote"],
    );
    const info = definitions[0]!;
    const output = info.outputSchema as Record<string, JsonValue>;
    const properties = output.properties as Record<string, JsonValue>;
    const platform = properties.platform as Record<string, JsonValue>;
    assert.equal(platform.additionalProperties, false);
    assert.deepEqual(platform.required, ["arch", "os"]);
});

test("Context installs wildcard definitions and executes environ_info through ToolCall hook", async () => {
    const executes = new Map<
        string,
        Parameters<ToolCallHooks["registerExecute"]>[1]
    >();
    const hooks = {
        registerContributor: () => () => undefined,
        registerExecute: (name: string, execute: Parameters<ToolCallHooks["registerExecute"]>[1]) => {
            executes.set(name, execute);
            return () => executes.delete(name);
        },
        registerReview: () => () => undefined,
    } as ToolCallHooks;
    const record = {
        createdAt: "2026-10-04T00:00:00.000Z",
        ctxId: "ctx-1",
        environments: [{ instance: "local" }],
        expiresAt: "2026-10-05T00:00:00.000Z",
        lastAccessedAt: "2026-10-04T00:00:00.000Z",
        principal: "alice",
        status: "active" as const,
    };
    let externalPrincipal: string | undefined;
    const contexts = {
        cleanup: {
            async reconcile() {},
        },
        environment: {
            async prepareLocal(
                _ctxId: string,
                _instance: string,
                workspace: string,
                options: {
                    external?: { principal: string };
                    beforeCommit?: (prepared: {
                        projectMemoryAgentFile: string;
                        projectMemoryDirectory: string;
                        temporaryDirectory: string;
                        workspace: string;
                    }) => Promise<void>;
                },
            ) {
                externalPrincipal = options.external?.principal;
                const prepared = {
                    projectMemoryAgentFile: `${workspace}/var/agent-work/INDEX.md`,
                    projectMemoryDirectory: `${workspace}/var/agent-work`,
                    temporaryDirectory: "/tmp/context",
                    workspace,
                };
                await options.beforeCommit?.(prepared);
                return prepared;
            },
            async rollbackUndisclosed() {},
        },
        registry: {
            async create() {
                return record;
            },
            async lookupExternal() {
                return undefined;
            },
        },
    } as unknown as ContextApi;
    const worker = {
        snapshot: () => ({ ready: true }),
        handshake: {
            platform: { arch: "x86_64", os: "linux" },
        },
        async prepareWorkspace(workspace: string) {
            return {
                projectMemoryAgentFile: `${workspace}/AGENTS.md`,
                projectMemoryDirectory: `${workspace}/.agent`,
                temporaryDirectory: "/tmp/context",
                workspace,
            };
        },
        async prepareExtensionResource() {
            return { directory: "/skills" };
        },
        async readAlerts() {
            return { advice: [] };
        },
    };

    const uninstall = installContextTools(contexts, hooks, {
        instances: {
            get: () => ({
                acquireLease: () => ({
                    instance: { worker } as never,
                    release() {},
                }),
                async acquireReference() {
                    throw new Error("Unexpected remote instance reference.");
                },
                async releaseReference() {},
            }),
        },
    });
    try {
        assert.equal(
            mcpTools.get("any-instance", "environ_info")?.definition.name,
            "environ_info",
        );
        const execute = executes.get("environ_info");
        assert.ok(execute);
        const result = await execute(
            "call-1",
            { workspace: "/repo" },
            {
                context: {
                    contextMode: "explicit",
                    externalBindings: [{ kind: "session", value: "s-1" }],
                    instance: "local" as InstanceName,
                    principal: "alice",
                    source: "mcp",
                },
                kind: "call",
                payload: { workspace: "/repo" },
                toolName: "environ_info",
            },
        );
        assert.equal(externalPrincipal, "alice");
        assert.equal((result as Record<string, JsonValue>).ctxId, "ctx-1");
        assert.equal((result as Record<string, JsonValue>).workspace, "/repo");
        assert.equal(
            (result as Record<string, JsonValue>).skillsDirectory,
            "/skills",
        );
    } finally {
        uninstall();
    }
    assert.equal(mcpTools.get("any-instance", "environ_info"), undefined);
});

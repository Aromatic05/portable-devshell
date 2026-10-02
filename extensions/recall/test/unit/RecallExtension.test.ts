import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest,
    type ExtensionContext,
    type ExtensionJsonValue,
} from "@portable-devshell/extension";

import {
    executeRecallModelCommand,
    executeRecallNativeCommand,
} from "../../src/builtin/RecallCommand.ts";
import { RecallService } from "../../src/builtin/RecallService.ts";

test("Recall Extension manifest declares only read-oriented runtime capabilities", async () => {
    const manifest = parseExtensionManifest(
        JSON.parse(
            await readFile(
                new URL(
                    "../../src/builtin/devshell-extension.json",
                    import.meta.url,
                ),
                "utf8",
            ),
        ),
    );

    assert.equal(manifest.schemaVersion, EXTENSION_MANIFEST_SCHEMA_VERSION);
    assert.equal(manifest.apiVersion, EXTENSION_API_VERSION);
    assert.equal(manifest.id, "recall");
    assert.equal(manifest.activation, "lazy");
    assert.deepEqual(manifest.capabilities, [
        "contextRuntime",
        "instanceRuntime",
    ]);
    assert.deepEqual(Object.keys(manifest.extensions).sort(), [
        "cli.model-commands",
        "cli.native-commands",
    ]);
});

test("Recall contexts merges current Contexts with retained ToolCall workspace history", async () => {
    const queries: Array<{ instance: string; query?: ExtensionJsonValue }> = [];
    const service = new RecallService(fakeContext(queries));

    assert.deepEqual(await service.contexts({ workspace: "/repo" }), {
        contexts: [
            {
                current: false,
                ctxId: "ctx-history",
                instances: ["other"],
                lastToolCallAt: "2026-10-02T10:00:00.000Z",
                toolCalls: 1,
            },
            {
                createdAt: "2026-10-01T00:00:00.000Z",
                current: true,
                ctxId: "ctx-current",
                instances: ["local"],
                lastAccessedAt: "2026-10-02T09:00:00.000Z",
                lastToolCallAt: "2026-10-02T09:30:00.000Z",
                status: "active",
                toolCalls: 1,
            },
        ],
        workspace: "/repo",
    });
    assert.deepEqual(
        queries.map((entry) => entry.instance),
        ["local", "other"],
    );
    for (const entry of queries) {
        assert.deepEqual(entry.query, {
            includeInput: false,
            includeOutput: false,
            workspace: "/repo",
        });
    }
});

test("Recall calls preserves ToolCall provenance and applies a global limit", async () => {
    const queries: Array<{ instance: string; query?: ExtensionJsonValue }> = [];
    const service = new RecallService(fakeContext(queries));

    assert.deepEqual(
        await service.calls({
            limit: 1,
            toolName: "file_read",
            workspace: "/repo",
        }),
        {
            calls: [
                {
                    callId: "call-history",
                    ctxId: "ctx-history",
                    explanation: "Read the implementation before changing it.",
                    instance: "other",
                    purpose: "Inspect implementation",
                    source: "mcp",
                    startedAt: "2026-10-02T10:00:00.000Z",
                    status: "completed",
                    toolName: "file_read",
                    workspace: "/repo",
                },
            ],
            workspace: "/repo",
        },
    );
    for (const entry of queries) {
        assert.deepEqual(entry.query, {
            includeInput: false,
            includeOutput: false,
            limit: 1,
            toolName: "file_read",
            workspace: "/repo",
        });
    }
});

test("Recall model command is scoped to the authoritative Workspace and instance", async () => {
    const queries: Array<{ instance: string; query?: ExtensionJsonValue }> = [];
    const service = new RecallService(fakeContext(queries));
    const signal = new AbortController().signal;

    const result = await executeRecallModelCommand(
        service,
        ["calls", "--limit", "5"],
        {
            context: {
                async instanceReference() {
                    return undefined;
                },
            },
            instance: "local",
            requestId: "req-model",
            signal,
            workspace: "/repo",
        },
    );
    assert.equal(result.kind, "json");
    assert.deepEqual(queries, [
        {
            instance: "local",
            query: {
                includeInput: false,
                includeOutput: false,
                limit: 5,
                workspace: "/repo",
            },
        },
    ]);
    await assert.rejects(
        executeRecallModelCommand(
            service,
            ["calls", "/other"],
            {
                context: {
                    async instanceReference() {
                        return undefined;
                    },
                },
                instance: "local",
                requestId: "req-model-2",
                signal,
                workspace: "/repo",
            },
        ),
        /cannot select another Workspace/u,
    );
});

test("Recall native command resolves a relative Workspace from the CLI working directory", async () => {
    const queries: Array<{ instance: string; query?: ExtensionJsonValue }> = [];
    const service = new RecallService(fakeContext(queries));
    const result = await executeRecallNativeCommand(
        service,
        ["calls", "child", "--instance", "local", "--limit", "2"],
        {
            localOwner: true,
            requestId: "req-native",
            signal: new AbortController().signal,
            workingDirectory: "/repo",
        },
    );

    assert.equal(result.kind, "json");
    assert.deepEqual(queries, [
        {
            instance: "local",
            query: {
                includeInput: false,
                includeOutput: false,
                limit: 2,
                workspace: "/repo/child",
            },
        },
    ]);
});

function fakeContext(
    queries: Array<{ instance: string; query?: ExtensionJsonValue }>,
): ExtensionContext {
    return {
        capabilities: {
            contextRuntime: {
                async list(query) {
                    assert.equal(query?.workspace, "/repo");
                    return [
                        {
                            createdAt: "2026-10-01T00:00:00.000Z",
                            ctxId: "ctx-current",
                            environments: [
                                { instance: "local", workspace: "/repo" },
                            ],
                            expiresAt: "2026-10-03T00:00:00.000Z",
                            instance: "local",
                            lastAccessedAt: "2026-10-02T09:00:00.000Z",
                            status: "active",
                            workspace: "/repo",
                        },
                    ];
                },
            },
            instanceRuntime: {
                async appendEvent() {},
                async list() {
                    return [
                        { enabled: true, name: "local" },
                        { enabled: true, name: "other" },
                    ];
                },
                async readToolCalls(instance, query) {
                    queries.push({ instance, query });
                    if (
                        typeof query === "object" &&
                        query !== null &&
                        !Array.isArray(query) &&
                        query.workspace === "/repo/child"
                    ) {
                        return [];
                    }
                    return instance === "local"
                        ? [
                              {
                                  callId: "call-current",
                                  ctxId: "ctx-current",
                                  instance: "local",
                                  source: "mcp",
                                  startedAt: "2026-10-02T09:30:00.000Z",
                                  status: "completed",
                                  toolName: "bash_run",
                                  workspace: "/repo",
                              },
                          ]
                        : [
                              {
                                  callId: "call-history",
                                  ctxId: "ctx-history",
                                  explanation:
                                      "Read the implementation before changing it.",
                                  instance: "other",
                                  purpose: "Inspect implementation",
                                  source: "mcp",
                                  startedAt: "2026-10-02T10:00:00.000Z",
                                  status: "completed",
                                  toolName: "file_read",
                                  workspace: "/repo",
                              },
                          ];
                },
            },
        },
        generation: "test-generation",
        id: "recall",
        logger: {
            debug() {},
            error() {},
            info() {},
            warn() {},
        },
        paths: {
            codeDirectory: "/code",
            dataDirectory: "/data",
            runtimeDirectory: "/runtime",
            stateDirectory: "/state",
        },
        register() {},
        version: "0.1.0",
    };
}

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
    EXTENSION_API_VERSION,
    EXTENSION_MANIFEST_SCHEMA_VERSION,
    parseExtensionManifest,
    type ExtensionContext,
} from "@portable-devshell/extension";
import type {
    ToolCallHistoryQuery,
    ToolCallHistoryRecord,
} from "@portable-devshell/extension/toolcall";

import {
    executeRecallModelCommand,
    executeRecallNativeCommand,
} from "../../src/builtin/RecallCommand.ts";
import { RecallService } from "../../src/builtin/RecallService.ts";

interface HistoryQuery {
    instance: string;
    query?: ToolCallHistoryQuery;
}

test("Recall Extension declares only read-only Context and ToolCall history capabilities", async () => {
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
        "context.observe",
        "toolcall.history",
    ]);
});

test("Recall contexts merges retained Contexts with bounded ToolCall workspace history and partial failures", async () => {
    const queries: HistoryQuery[] = [];
    const service = new RecallService(fakeContext(queries));

    assert.deepEqual(await service.contexts({ workspace: "/repo" }), {
        contexts: [
            {
                ctxId: "ctx-history",
                instances: ["other"],
                lastToolCallAt: "2026-10-02T10:00:00.000Z",
                origin: "tool-call-history",
                status: "history-only",
                toolCalls: 1,
            },
            {
                createdAt: "2026-10-01T00:00:00.000Z",
                ctxId: "ctx-current",
                instances: ["local"],
                lastAccessedAt: "2026-10-02T09:00:00.000Z",
                lastToolCallAt: "2026-10-02T09:30:00.000Z",
                origin: "context-registry",
                status: "active",
                toolCalls: 1,
            },
        ],
        issues: [{ instance: "broken", message: "history unavailable" }],
        truncatedInstances: [],
        workspace: "/repo",
    });

    const firstPages = queries.filter((entry) => entry.query?.before === undefined);
    assert.deepEqual(
        firstPages.map((entry) => entry.instance),
        ["local", "other", "broken"],
    );
    for (const entry of firstPages.filter((item) => item.instance !== "broken")) {
        assert.deepEqual(entry.query, {
            includeInput: false,
            includeOutput: false,
            limit: 500,
            maxBytes: 512 * 1024,
            workspace: "/repo",
        });
    }
});

test("Recall calls preserves provenance, applies a global limit, and returns partial results", async () => {
    const queries: HistoryQuery[] = [];
    const service = new RecallService(fakeContext(queries));

    assert.deepEqual(
        await service.calls({
            limit: 1,
            toolName: "file_read",
            workspace: "/repo",
        }),
        {
            calls: [historyCall()],
            issues: [{ instance: "broken", message: "history unavailable" }],
            workspace: "/repo",
        },
    );
    const reads = queries.filter((entry) => entry.instance !== "broken");
    for (const entry of reads) {
        assert.deepEqual(entry.query, {
            includeInput: false,
            includeOutput: false,
            limit: 1,
            maxBytes: 8 * 1024 * 1024,
            toolName: "file_read",
            workspace: "/repo",
        });
    }
});

test("Recall model command uses authoritative scope and exposes model-specific help", async () => {
    const queries: HistoryQuery[] = [];
    const service = new RecallService(fakeContext(queries));
    const invocation = {
        context: {
            async instanceReference() {
                return undefined;
            },
        },
        instance: "local",
        requestId: "req-model",
        signal: new AbortController().signal,
        workspace: "/repo",
    };

    const result = await executeRecallModelCommand(
        service,
        ["calls", "--limit", "5"],
        invocation,
    );
    assert.equal(result.kind, "json");
    assert.match(result.text ?? "", /TIME\tSTATUS\tTOOL/u);
    assert.deepEqual(queries, [
        {
            instance: "local",
            query: {
                includeInput: false,
                includeOutput: false,
                limit: 5,
                maxBytes: 8 * 1024 * 1024,
                workspace: "/repo",
            },
        },
    ]);

    const help = await executeRecallModelCommand(service, ["--help"], invocation);
    assert.equal(help.kind, "text");
    assert.doesNotMatch(help.text, /\[workspace\]|--instance/u);
    assert.match(help.text, /authoritative current Workspace and instance/u);

    await assert.rejects(
        executeRecallModelCommand(service, ["calls", "/other"], invocation),
        /cannot select another Workspace/u,
    );
});

test("Recall native command resolves relative Workspace and returns structured JSON with text rendering", async () => {
    const queries: HistoryQuery[] = [];
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
    assert.match(result.text ?? "", /Workspace: \/repo\/child/u);
    assert.match(result.text ?? "", /TIME\tSTATUS\tTOOL/u);
    assert.deepEqual(queries, [
        {
            instance: "local",
            query: {
                includeInput: false,
                includeOutput: false,
                limit: 2,
                maxBytes: 8 * 1024 * 1024,
                workspace: "/repo/child",
            },
        },
    ]);
});

test("Recall rejects call limits above the host history bound", async () => {
    await assert.rejects(
        executeRecallNativeCommand(
            new RecallService(fakeContext([])),
            ["calls", "--limit", "1001"],
            {
                localOwner: true,
                requestId: "req-limit",
                signal: new AbortController().signal,
                workingDirectory: "/repo",
            },
        ),
        /between 1 and 1000/u,
    );
});

function fakeContext(queries: HistoryQuery[]): ExtensionContext {
    return {
        capabilities: {
            contextObserve: {
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
                            lastAccessedAt: "2026-10-02T09:00:00.000Z",
                            status: "active",
                        },
                    ];
                },
            },
            toolCallHistory: {
                async listInstances() {
                    return ["local", "other", "broken"];
                },
                async read(instance, query) {
                    queries.push({ instance, query });
                    if (instance === "broken")
                        throw new Error("history unavailable");
                    if (query?.workspace === "/repo/child") return [];
                    if (query?.before !== undefined) return [];
                    return instance === "local" ? [currentCall()] : [historyCall()];
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

function currentCall(): ToolCallHistoryRecord {
    return {
        callId: "call-current",
        ctxId: "ctx-current",
        inputSummary: "{}",
        instance: "local",
        source: "mcp",
        startedAt: "2026-10-02T09:30:00.000Z",
        status: "completed",
        toolName: "bash_run",
        workspace: "/repo",
    };
}

function historyCall(): ToolCallHistoryRecord {
    return {
        callId: "call-history",
        ctxId: "ctx-history",
        explanation: "Read the implementation before changing it.",
        inputSummary: "{}",
        instance: "other",
        purpose: "Inspect implementation",
        source: "mcp",
        startedAt: "2026-10-02T10:00:00.000Z",
        status: "completed",
        toolName: "file_read",
        workspace: "/repo",
    };
}

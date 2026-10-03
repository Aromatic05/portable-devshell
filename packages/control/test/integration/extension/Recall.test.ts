import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { AuditDatabase } from "@portable-devshell/core";
import {
    asInstanceName,
    type ToolCallQuery,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { createControlExtensionPointRegistry } from "../../../src/composition/Extension.ts";
import { CliExtensionCommandService } from "../../../src/extension/cli/command/Service.ts";
import { ExtensionContextObserveCapabilityControl } from "../../../src/extension/capability/Context.ts";
import { ExtensionLoader } from "../../../src/extension/discovery/Loader.ts";
import { ExtensionHost } from "../../../src/extension/Host.ts";
import { ExtensionInstallService } from "../../../src/extension/install/Service.ts";
import { ExtensionPathLayout } from "../../../src/extension/state/Layout.ts";
import { ExtensionRegistryStore } from "../../../src/extension/state/Store.ts";
import type { InstanceDescriptor } from "@portable-devshell/core";
import { InstanceRegistry } from "@portable-devshell/core";
import { ToolCallProvenanceStore } from "@portable-devshell/core";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

const RECALL_SOURCE = fileURLToPath(
    new URL("../../../../../extensions/recall/src/builtin/", import.meta.url),
);

test("builtin Recall reads real SQLite ToolCall audit with Control provenance through the sandbox", async (t) => {
    const root = await createTestTempDirectory("recall-e2e");
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    const database = new AuditDatabase(join(root, "audit.sqlite3"), {
        maxBytes: 16 * 1024 * 1024,
        now: () => now,
        retentionDays: 30,
    });
    const audit = database.toolCallStore({
        timestamp: (record) => record.completedAt ?? record.startedAt,
    });
    const provenance = new ToolCallProvenanceStore(
        join(root, "tool-call-provenance.jsonl"),
        {
            now: () => now,
            retentionDays: 30,
        },
    );
    const instanceName = asInstanceName("alpha");
    await audit.append(
        toolCall({
            callId: "call-recall",
            ctxId: "ctx-recall",
            instance: instanceName,
            toolName: "file_read",
            workspace: "/repo",
        }),
    );
    await audit.append(
        toolCall({
            callId: "call-other-workspace",
            ctxId: "ctx-other",
            instance: instanceName,
            toolName: "bash_run",
            workspace: "/other",
        }),
    );
    await provenance.record({
        callId: "call-recall",
        explanation: "Read the implementation before changing it.",
        instance: instanceName,
        purpose: "Inspect Recall implementation",
    });

    const instances = new InstanceRegistry([
        {
            enabled: true,
            name: instanceName,
            worker: {
                async readToolCalls(query: ToolCallQuery) {
                    return await audit.readQuery(query);
                },
            },
        } as unknown as InstanceDescriptor,
    ]);
    const paths = new ExtensionPathLayout({
        dataHome: join(root, "data"),
        homeDirectory: join(root, "home"),
        runtimeRoot: join(root, "runtime"),
    });
    const host = new ExtensionHost({
        loader: new ExtensionLoader({
            contextObserveFactory: ({ allowed, extensionId }) =>
                new ExtensionContextObserveCapabilityControl({
                    allowed,
                    extensionId,
                    listContexts: async () => [],
                }),
            instances,
            paths,
            points: createControlExtensionPointRegistry(),
            toolCallDecorator: provenance,
        }),
        registry: new ExtensionRegistryStore(paths.registryFile),
    });
    await host.start();
    t.after(async () => {
        await host.stop().catch(() => undefined);
        database.close();
        await rm(root, { force: true, recursive: true });
    });

    const installer = new ExtensionInstallService({ host, paths });
    const installed = await installer.installBuiltin("recall", RECALL_SOURCE);
    assert.equal(installed.id, "recall");
    assert.equal(installed.state, "installed");

    const commands = new CliExtensionCommandService(host, {
        surface: "native",
    });
    const invocation = {
        localOwner: true,
        requestId: "recall-e2e",
        signal: new AbortController().signal,
        workingDirectory: "/repo",
    };

    const calls = await commands.command(
        "recall",
        ["calls", "/repo", "--instance", "alpha", "--limit", "10"],
        invocation,
    );
    assert.equal(calls.kind, "json");
    assert.match(calls.text ?? "", /Inspect Recall implementation/u);
    const callsValue = calls.value as {
        calls: Array<{
            callId: string;
            explanation?: string;
            purpose?: string;
            workspace?: string;
        }>;
        issues: unknown[];
        workspace: string;
    };
    assert.equal(callsValue.workspace, "/repo");
    assert.deepEqual(callsValue.issues, []);
    assert.deepEqual(
        callsValue.calls.map((record) => ({
            callId: record.callId,
            explanation: record.explanation,
            purpose: record.purpose,
            workspace: record.workspace,
        })),
        [
            {
                callId: "call-recall",
                explanation: "Read the implementation before changing it.",
                purpose: "Inspect Recall implementation",
                workspace: "/repo",
            },
        ],
    );

    const contexts = await commands.command(
        "recall",
        ["contexts", "/repo"],
        invocation,
    );
    assert.equal(contexts.kind, "json");
    const contextsValue = contexts.value as {
        contexts: Array<{
            ctxId: string;
            origin: string;
            status: string;
            toolCalls: number;
        }>;
        issues: unknown[];
        truncatedInstances: string[];
        workspace: string;
    };
    assert.deepEqual(contextsValue, {
        contexts: [
            {
                ctxId: "ctx-recall",
                instances: ["alpha"],
                lastToolCallAt: "2026-10-02T10:00:00.000Z",
                origin: "tool-call-history",
                status: "history-only",
                toolCalls: 1,
            },
        ],
        issues: [],
        truncatedInstances: [],
        workspace: "/repo",
    });
});

function toolCall(input: {
    callId: string;
    ctxId: string;
    instance: ReturnType<typeof asInstanceName>;
    toolName: string;
    workspace: string;
}): ToolCallRecord {
    return {
        callId: input.callId,
        completedAt: "2026-10-02T10:00:01.000Z",
        ctxId: input.ctxId,
        inputSummary: "{}",
        instance: input.instance,
        source: "mcp",
        startedAt: "2026-10-02T10:00:00.000Z",
        status: "completed",
        toolName: input.toolName,
        workspace: input.workspace,
    };
}

import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionToolCallHistoryCapabilityControl } from "../../../../../src/control/extension/generation/capability/ToolCallHistory.ts";
import type { InstanceDescriptor } from "../../../../../src/control/instance/Descriptor.ts";
import { InstanceRegistry } from "../../../../../src/control/instance/registry/Registry.ts";

test("ToolCall history capability is read-only, typed, bounded, and provenance-decorated", async () => {
    const queries: unknown[] = [];
    const instances = new InstanceRegistry([
        {
            enabled: true,
            name: "demo-local",
            worker: {
                async readToolCalls(query: unknown) {
                    queries.push(query);
                    return [
                        {
                            callId: "call-1",
                            ctxId: "ctx-1",
                            inputSummary: "{}",
                            instance: "demo-local",
                            source: "mcp",
                            startedAt: "2026-10-02T00:00:00.000Z",
                            status: "completed",
                            toolName: "file_read",
                            workspace: "/repo",
                        },
                    ];
                },
            },
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionToolCallHistoryCapabilityControl({
        allowed: true,
        extensionId: "recall",
        instances,
        toolCallDecorator: {
            async decorate(instance, records) {
                assert.equal(instance, "demo-local");
                return records.map((record) => ({
                    ...record,
                    explanation: "why",
                    purpose: "inspect implementation",
                }));
            },
        },
    });

    assert.deepEqual(await capability.listInstances(), ["demo-local"]);
    assert.deepEqual(
        await capability.read("demo-local", {
            includeInput: false,
            includeOutput: false,
            limit: 5_000,
            maxBytes: 64 * 1024 * 1024,
            workspace: "/repo",
        }),
        [
            {
                callId: "call-1",
                ctxId: "ctx-1",
                explanation: "why",
                inputSummary: "{}",
                instance: "demo-local",
                purpose: "inspect implementation",
                source: "mcp",
                startedAt: "2026-10-02T00:00:00.000Z",
                status: "completed",
                toolName: "file_read",
                workspace: "/repo",
            },
        ],
    );
    assert.deepEqual(queries, [
        {
            includeInput: false,
            includeOutput: false,
            limit: 1_000,
            maxBytes: 8 * 1024 * 1024,
            workspace: "/repo",
        },
    ]);
});

test("ToolCall history capability rejects undeclared access", async () => {
    const capability = new ExtensionToolCallHistoryCapabilityControl({
        allowed: false,
        extensionId: "example",
        instances: new InstanceRegistry([]),
    });

    await assert.rejects(
        capability.listInstances(),
        /did not declare the toolCallHistory capability/u,
    );
});

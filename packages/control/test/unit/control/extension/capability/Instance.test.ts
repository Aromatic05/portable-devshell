import assert from "node:assert/strict";
import test from "node:test";

import {
    ExtensionInstanceCapabilityControl,
    ExtensionInstanceRuntimeCapabilityControl,
} from "../../../../../src/control/extension/generation/capability/Instance.ts";
import type { InstanceDescriptor } from "../../../../../src/control/instance/Descriptor.ts";
import { InstanceRegistry } from "../../../../../src/control/instance/registry/Registry.ts";
import { RuntimeSubscriptionManager } from "../../../../../src/instance/execution/runtime/Subscription.ts";

test("Instance capability watchEvents filters authoritative runtime events and stops on cancellation", async () => {
    let subscriptions = 0;
    const worker = {
        subscribe(fromSeq: number) {
            assert.equal(fromSeq, 1);
            subscriptions += 1;
            if (subscriptions === 1)
                return { events: [], kind: "events" as const, lastSeq: 0 };
            return {
                events: [
                    {
                        at: "now",
                        instanceName: "demo-local",
                        seq: 1,
                        type: "log.appended",
                    },
                    {
                        at: "now",
                        instanceName: "demo-local",
                        seq: 1,
                        type: "instance.readyChanged",
                    },
                ],
                kind: "events" as const,
                lastSeq: 1,
            };
        },
    };
    const instances = new InstanceRegistry([
        {
            name: "demo-local",
            worker,
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionInstanceCapabilityControl({
        allowed: true,
        create: {
            async createInstance() {
                throw new Error("unused");
            },
            getSchema() {
                return {} as never;
            },
            validateDraft() {
                return {} as never;
            },
        },
        editor: {
            async deleteInstance() {
                throw new Error("unused");
            },
            async disableInstance() {
                throw new Error("unused");
            },
            async enableInstance() {
                throw new Error("unused");
            },
        },
        extensionId: "instance",
        instances,
        listConfigured: () => [
            {
                enabled: true,
                mcpEnabled: true,
                name: "demo-local",
                provider: "local",
            },
        ],
        subscriptions: new RuntimeSubscriptionManager(1),
    });
    const controller = new AbortController();
    const events: string[] = [];

    await capability.watchEvents("demo-local", {
        eventTypes: ["log.appended"],
        fromSeq: 1,
        onEvent(event) {
            events.push(`${event.seq}:${event.type}`);
            controller.abort(new Error("test complete"));
        },
        signal: controller.signal,
    });

    assert.deepEqual(events, ["1:log.appended"]);
    assert.ok(subscriptions >= 2);
});

test("Instance runtime capability appends events and reads audit ToolCalls without management authority", async () => {
    const appended: Array<{ type: string; data: unknown }> = [];
    const queries: unknown[] = [];
    const instances = new InstanceRegistry([
        {
            name: "demo-local",
            worker: {
                async appendControlEvent(type: string, data: unknown) {
                    appended.push({ data, type });
                },
                async readToolCalls(query: unknown) {
                    queries.push(query);
                    return [
                        {
                            callId: "call-1",
                            context: { ctxId: "ctx-1", source: "mcp" },
                            input: { message: "progress" },
                            status: "succeeded",
                            toolName: "todo_report",
                        },
                    ];
                },
            },
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionInstanceRuntimeCapabilityControl({
        allowed: true,
        extensionId: "comment",
        instances,
    });

    await capability.appendEvent("demo-local", "context.message.queued", {
        ctxId: "ctx-1",
    });
    assert.deepEqual(
        await capability.readToolCalls("demo-local", {
            includeInput: true,
            toolName: "todo_report",
        }),
        [
            {
                callId: "call-1",
                context: { ctxId: "ctx-1", source: "mcp" },
                input: { message: "progress" },
                status: "succeeded",
                toolName: "todo_report",
            },
        ],
    );
    assert.deepEqual(appended, [
        {
            data: { ctxId: "ctx-1" },
            type: "context.message.queued",
        },
    ]);
    assert.deepEqual(queries, [
        { includeInput: true, toolName: "todo_report" },
    ]);
});

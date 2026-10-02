import assert from "node:assert/strict";
import test from "node:test";

import {
    ExtensionInstanceEventPublishCapabilityControl,
    ExtensionInstanceManageCapabilityControl,
    ExtensionInstanceObserveCapabilityControl,
} from "../../../../../src/control/extension/generation/capability/Instance.ts";
import type { InstanceDescriptor } from "../../../../../src/control/instance/Descriptor.ts";
import { InstanceRegistry } from "../../../../../src/control/instance/registry/Registry.ts";
import { RuntimeSubscriptionManager } from "../../../../../src/instance/execution/runtime/Subscription.ts";

const readySnapshot = {
    connectionState: "connected" as const,
    daemonState: "running" as const,
    lastSeq: 1,
    name: "demo-local",
    ready: true,
    status: "ready" as const,
};

const stoppedSnapshot = {
    connectionState: "disconnected" as const,
    daemonState: "stopped" as const,
    lastSeq: 2,
    name: "demo-local",
    ready: false,
    status: "stopped" as const,
};

test("Instance observe capability watchEvents filters authoritative runtime events and stops on cancellation", async () => {
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
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
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

test("Instance observe capability never exposes lifecycle mutation", async () => {
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
        extensionId: "instance",
        instances: new InstanceRegistry([]),
        listConfigured: () => [],
        subscriptions: new RuntimeSubscriptionManager(1),
    });

    assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(capability)).sort(),
        [
            "constructor",
            "list",
            "readLogs",
            "refresh",
            "snapshot",
            "watchEvents",
        ],
    );
    for (const operation of [
        "create",
        "createSchema",
        "delete",
        "disable",
        "enable",
        "start",
        "stop",
        "validateCreate",
    ]) {
        assert.equal(
            (capability as unknown as Record<string, unknown>)[operation],
            undefined,
            `observe must not expose ${operation}`,
        );
    }
});

test("Instance observe capability lists configured instances with authoritative snapshots", async () => {
    const instances = new InstanceRegistry([
        {
            name: "demo-local",
            worker: {
                snapshot: () => readySnapshot,
            },
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
        extensionId: "instance",
        instances,
        listConfigured: () => [
            {
                enabled: true,
                mcpEnabled: true,
                name: "demo-local",
                provider: "local",
            },
            {
                enabled: false,
                mcpEnabled: false,
                name: "remote-only",
                provider: "ssh",
            },
        ],
        subscriptions: new RuntimeSubscriptionManager(1),
    });

    assert.deepEqual(await capability.list(), [
        {
            enabled: true,
            mcpEnabled: true,
            name: "demo-local",
            provider: "local",
            snapshot: readySnapshot,
        },
        {
            enabled: false,
            mcpEnabled: false,
            name: "remote-only",
            provider: "ssh",
        },
    ]);
    assert.deepEqual(await capability.snapshot("demo-local"), readySnapshot);
});

test("Instance manage capability owns lifecycle operations without observation", async () => {
    const calls: string[] = [];
    const instances = new InstanceRegistry([
        {
            enabled: true,
            name: "demo-local",
            worker: {
                async start() {
                    calls.push("start");
                    return readySnapshot;
                },
                async stop() {
                    calls.push("stop");
                    return stoppedSnapshot;
                },
            },
        } as unknown as InstanceDescriptor,
        {
            enabled: false,
            name: "disabled",
            worker: {
                async start() {
                    throw new Error("disabled instance must not start");
                },
            },
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionInstanceManageCapabilityControl({
        allowed: true,
        create: {
            async createInstance(draft) {
                calls.push(`create:${JSON.stringify(draft)}`);
                return {
                    enabled: true,
                    mcpPath: "/mcp",
                    name: "created",
                    snapshot: readySnapshot as never,
                };
            },
            getSchema() {
                return {} as never;
            },
            validateDraft(draft) {
                calls.push(`validate:${JSON.stringify(draft)}`);
                return { name: "created" } as never;
            },
        },
        editor: {
            async deleteInstance(params) {
                calls.push(
                    `delete:${(params as { instanceName: string }).instanceName}`,
                );
                return {};
            },
            async disableInstance(params) {
                calls.push(
                    `disable:${(params as { instanceName: string }).instanceName}`,
                );
                return {};
            },
            async enableInstance(params) {
                calls.push(
                    `enable:${(params as { instanceName: string }).instanceName}`,
                );
                return {};
            },
        },
        extensionId: "instance",
        instances,
    });

    // Management owns the lifecycle surface; observation methods are absent.
    assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(capability)).sort(),
        [
            "constructor",
            "create",
            "createSchema",
            "delete",
            "disable",
            "enable",
            "start",
            "stop",
            "validateCreate",
        ],
    );
    for (const operation of [
        "list",
        "readLogs",
        "refresh",
        "snapshot",
        "watchEvents",
    ]) {
        assert.equal(
            (capability as unknown as Record<string, unknown>)[operation],
            undefined,
            `manage must not expose ${operation}`,
        );
    }

    assert.deepEqual(await capability.createSchema(), {});
    assert.deepEqual(await capability.validateCreate({ name: "created" }), {
        name: "created",
    });
    assert.deepEqual(await capability.create({ name: "created" }), {
        enabled: true,
        mcpPath: "/mcp",
        name: "created",
        snapshot: readySnapshot,
    });
    await capability.enable("demo-local");
    await capability.disable("demo-local");
    assert.deepEqual(await capability.start("demo-local"), readySnapshot);
    assert.deepEqual(await capability.stop("demo-local"), stoppedSnapshot);
    await assert.rejects(capability.start("disabled"), /is disabled/u);
    await capability.delete("demo-local");

    assert.deepEqual(calls, [
        'validate:{"name":"created"}',
        'create:{"name":"created"}',
        "enable:demo-local",
        "disable:demo-local",
        "start",
        "stop",
        "delete:demo-local",
    ]);
});

test("Instance event publish capability is write-only and does not observe or manage", async () => {
    const appended: Array<{ data: unknown; type: string }> = [];
    const instances = new InstanceRegistry([
        {
            name: "demo-local",
            worker: {
                async appendControlEvent(type: string, data: unknown) {
                    appended.push({ data, type });
                },
            },
        } as unknown as InstanceDescriptor,
    ]);
    const capability = new ExtensionInstanceEventPublishCapabilityControl({
        allowed: true,
        extensionId: "comment",
        instances,
    });

    assert.deepEqual(
        Object.getOwnPropertyNames(Object.getPrototypeOf(capability)).sort(),
        ["appendEvent", "constructor"],
    );
    for (const operation of [
        "list",
        "readLogs",
        "refresh",
        "snapshot",
        "watchEvents",
        "create",
        "delete",
        "disable",
        "enable",
        "start",
        "stop",
    ]) {
        assert.equal(
            (capability as unknown as Record<string, unknown>)[operation],
            undefined,
            `event publish must not expose ${operation}`,
        );
    }

    await capability.appendEvent("demo-local", "context.message.queued", {
        ctxId: "ctx-1",
    });
    assert.deepEqual(appended, [
        {
            data: { ctxId: "ctx-1" },
            type: "context.message.queued",
        },
    ]);

    await assert.rejects(
        capability.appendEvent("demo-local", "not a namespaced event"),
        /event type is invalid/u,
    );
    await assert.rejects(
        capability.appendEvent("missing", "context.message.queued"),
        /not found/u,
    );
});

test("Instance capabilities reject undeclared access independently", async () => {
    const instances = new InstanceRegistry([]);
    const observe = new ExtensionInstanceObserveCapabilityControl({
        allowed: false,
        extensionId: "example",
        instances,
        listConfigured: () => [],
        subscriptions: new RuntimeSubscriptionManager(1),
    });
    const manage = new ExtensionInstanceManageCapabilityControl({
        allowed: false,
        create: {} as never,
        editor: {} as never,
        extensionId: "example",
        instances,
    });
    const eventPublish = new ExtensionInstanceEventPublishCapabilityControl({
        allowed: false,
        extensionId: "example",
        instances,
    });

    await assert.rejects(
        observe.list(),
        /did not declare the instance\.observe capability/u,
    );
    await assert.rejects(
        manage.createSchema(),
        /did not declare the instance\.manage capability/u,
    );
    await assert.rejects(
        eventPublish.appendEvent("demo-local", "context.message.queued"),
        /did not declare the instance\.events\.publish capability/u,
    );
});

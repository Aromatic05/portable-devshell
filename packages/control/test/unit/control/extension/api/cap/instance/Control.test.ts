import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    type InstanceRuntimeTransport,
    type ProcessTransport,
} from "@portable-devshell/shared";

import {
    ExtensionInstanceEventPublishCapabilityControl,
    ExtensionInstanceManageCapabilityControl,
    ExtensionInstanceObserveCapabilityControl,
} from "../../../../../../../src/extension/api/cap/instance/index.ts";

const readySnapshot = {
    connectionState: "connected" as const,
    daemonState: "running" as const,
    lastSeq: 1,
    name: asInstanceName("demo-local"),
    ready: true,
    status: "ready" as const,
};

const stoppedSnapshot = {
    connectionState: "disconnected" as const,
    daemonState: "stopped" as const,
    lastSeq: 2,
    name: asInstanceName("demo-local"),
    ready: false,
    status: "stopped" as const,
};

function processStub(
    overrides: Partial<ProcessTransport> = {},
): ProcessTransport {
    return {
        readLogs: async () => [],
        refresh: async () => ({ lastSeq: 1, snapshot: readySnapshot }),
        snapshot: async () => ({ lastSeq: 1, snapshot: readySnapshot }),
        start: async () => ({
            cancel() {},
            requestId: "request",
            snapshot: Promise.resolve(readySnapshot),
        }),
        stop: async () => stoppedSnapshot,
        subscribe: async () => ({
            close() {},
            next: async () => ({ kind: "closed" as const }),
        }),
        ...overrides,
    };
}

function runtimeStub(
    overrides: Partial<InstanceRuntimeTransport> = {},
): InstanceRuntimeTransport {
    return {
        acquireReference: async () => ({}),
        appendEvent: async () => {},
        readEvents: async () => ({
            events: [],
            kind: "events" as const,
            lastSeq: 0,
        }),
        releaseReference: async () => {},
        subscribeEvents: async () => ({
            close() {},
            next: async () => ({ kind: "closed" as const }),
        }),
        ...overrides,
    };
}

test("Instance observe capability watchEvents filters authoritative runtime events and stops on cancellation", async () => {
    let subscriptions = 0;
    const runtime = runtimeStub({
        async subscribeEvents(fromSeq) {
            assert.equal(fromSeq, 1);
            subscriptions += 1;
            let closed = false;
            let step = 0;
            return {
                close() {
                    closed = true;
                },
                async next() {
                    if (closed) return { kind: "closed" as const };
                    step += 1;
                    return {
                        event: {
                            at: "now",
                            instanceName: asInstanceName("demo-local"),
                            seq: step,
                            type:
                                step === 1
                                    ? "log.appended"
                                    : "instance.readyChanged",
                        },
                        kind: "event" as const,
                    };
                },
            };
        },
    });
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
        extensionId: "instance",
        listConfigured: () => [
            {
                enabled: true,
                mcpEnabled: true,
                name: "demo-local",
                provider: "local",
            },
        ],
        process: () => processStub(),
        runtime: () => runtime,
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
    assert.equal(subscriptions, 1);
});

test("Instance observe capability never exposes lifecycle mutation", async () => {
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
        extensionId: "instance",
        listConfigured: () => [],
        process: () => processStub(),
        runtime: () => runtimeStub(),
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
    let refreshes = 0;
    const logQuery = { fromSeq: 2, limit: 7 };
    const capability = new ExtensionInstanceObserveCapabilityControl({
        allowed: true,
        extensionId: "instance",
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
        process: (name) =>
            processStub({
                async readLogs(query) {
                    assert.equal(name, "demo-local");
                    assert.deepEqual(query, logQuery);
                    return [{
                        at: "now",
                        instanceName: asInstanceName(name),
                        message: "worker output",
                        seq: 2,
                        stream: "stdout",
                    }];
                },
                async refresh() {
                    refreshes += 1;
                    return { lastSeq: 2, snapshot: stoppedSnapshot };
                },
                async snapshot() {
                    return { lastSeq: 1, snapshot: readySnapshot };
                },
            }),
        runtime: () => runtimeStub(),
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
    assert.deepEqual(await capability.refresh("demo-local"), stoppedSnapshot);
    assert.equal(refreshes, 1);
    assert.deepEqual(await capability.readLogs("demo-local", logQuery), [{
        at: "now",
        instanceName: asInstanceName("demo-local"),
        message: "worker output",
        seq: 2,
        stream: "stdout",
    }]);
});

test("Instance manage capability owns lifecycle operations without observation", async () => {
    const calls: string[] = [];
    const capability = new ExtensionInstanceManageCapabilityControl({
        allowed: true,
        create: {
            async createInstance(draft) {
                calls.push(`create:${JSON.stringify(draft)}`);
                return {
                    enabled: true,
                    mcpPath: "/mcp",
                    name: "created",
                    snapshot: readySnapshot,
                };
            },
            getSchema() {
                return {
                    container: {
                        defaultMode: "preset",
                        modes: [
                            "preset",
                            "dockerfile",
                            "compose",
                            "existingImage",
                            "existingStoppedContainer",
                        ],
                        presets: [],
                    },
                    providers: ["local"],
                    defaultProvider: "local",
                    defaultEnabled: true,
                    defaultMcpEnabled: false,
                    defaultModelExtensions: [],
                    defaultSecurityMode: "disabled",
                };
            },
            validateDraft(draft) {
                calls.push(`validate:${JSON.stringify(draft)}`);
                return {
                    enabled: true,
                    extensions: { model: [] },
                    mcp: {
                        auth: { mode: "none" },
                        contextMode: "explicit",
                        enabled: true,
                        path: "/mcp",
                    },
                    name: "created",
                    provider: "local",
                    security: { mode: "disabled" },
                };
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
        process: (name) =>
            processStub({
                async start() {
                    if (name === "disabled")
                        throw new Error("Instance disabled is disabled.");
                    calls.push(`start:${name}`);
                    return {
                        cancel() {},
                        requestId: "request",
                        snapshot: Promise.resolve(readySnapshot),
                    };
                },
                async stop() {
                    calls.push(`stop:${name}`);
                    return stoppedSnapshot;
                },
            }),
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

    assert.deepEqual(await capability.createSchema(), {
        container: {
            defaultMode: "preset",
            modes: [
                "preset",
                "dockerfile",
                "compose",
                "existingImage",
                "existingStoppedContainer",
            ],
            presets: [],
        },
        defaultEnabled: true,
        defaultMcpEnabled: false,
        defaultModelExtensions: [],
        defaultProvider: "local",
        defaultSecurityMode: "disabled",
        providers: ["local"],
    });
    assert.deepEqual(await capability.validateCreate({ name: "created" }), {
        enabled: true,
        extensions: { model: [] },
        mcp: {
            auth: { mode: "none" },
            contextMode: "explicit",
            enabled: true,
            path: "/mcp",
        },
        name: "created",
        provider: "local",
        security: { mode: "disabled" },
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
        "start:demo-local",
        "stop:demo-local",
        "delete:demo-local",
    ]);
});

test("Instance event publish capability is write-only and does not observe or manage", async () => {
    const appended: Array<{ data: unknown; type: string }> = [];
    const capability = new ExtensionInstanceEventPublishCapabilityControl({
        allowed: true,
        extensionId: "comment",
        runtime: (name) =>
            runtimeStub({
                async appendEvent(type, data) {
                    if (name !== "demo-local")
                        throw new Error(`Instance ${name} was not found.`);
                    appended.push({ data, type });
                },
            }),
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
    const observe = new ExtensionInstanceObserveCapabilityControl({
        allowed: false,
        extensionId: "example",
        listConfigured: () => [],
        process: () => processStub(),
        runtime: () => runtimeStub(),
    });
    const manage = new ExtensionInstanceManageCapabilityControl({
        allowed: false,
        create: {
            async createInstance() {
                throw new Error("must not create");
            },
            getSchema() {
                return {
                    container: {
                        defaultMode: "preset",
                        modes: [
                            "preset",
                            "dockerfile",
                            "compose",
                            "existingImage",
                            "existingStoppedContainer",
                        ],
                        presets: [],
                    },
                    providers: ["local"],
                    defaultProvider: "local",
                    defaultEnabled: true,
                    defaultMcpEnabled: false,
                    defaultModelExtensions: [],
                    defaultSecurityMode: "disabled",
                };
            },
            validateDraft() {
                throw new Error("must not validate");
            },
        },
        editor: {
            async deleteInstance() {
                throw new Error("must not delete");
            },
            async disableInstance() {
                throw new Error("must not disable");
            },
            async enableInstance() {
                throw new Error("must not enable");
            },
        },
        extensionId: "example",
        process: () => processStub(),
    });
    const eventPublish = new ExtensionInstanceEventPublishCapabilityControl({
        allowed: false,
        extensionId: "example",
        runtime: () => runtimeStub(),
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

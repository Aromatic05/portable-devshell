import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionCapabilities } from "../../src/index.ts";
import type { ExtensionContextObserveCapability } from "../../src/domain/context.ts";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
    ExtensionInstanceSnapshot,
} from "../../src/domain/instance.ts";

const snapshot: ExtensionInstanceSnapshot = {
    connectionState: "connected",
    daemonState: "running",
    lastSeq: 0,
    name: "example",
    ready: true,
    status: "running",
};

const capabilityKeys: readonly (keyof ExtensionCapabilities)[] = [
    "artifacts",
    "assets",
    "contextObserve",
    "instanceEventPublish",
    "instanceManage",
    "instanceObserve",
    "processes",
    "toolCallHistory",
    "workerDelegate",
    "workerExecute",
];

test("Runtime ExtensionCapabilities expose the v5 capability taxonomy", () => {
    const uncovered: Record<
        Exclude<keyof ExtensionCapabilities, (typeof capabilityKeys)[number]>,
        never
    > = {};
    assert.deepEqual(uncovered, {});
    assert.deepEqual([...capabilityKeys].sort(), [
        "artifacts",
        "assets",
        "contextObserve",
        "instanceEventPublish",
        "instanceManage",
        "instanceObserve",
        "processes",
        "toolCallHistory",
        "workerDelegate",
        "workerExecute",
    ]);
});

test("Context observation exposes read-only discovery without runtime mutation", () => {
    const contextObserve = {
        list: async () => [],
    } satisfies ExtensionContextObserveCapability;

    assert.deepEqual(Object.keys(contextObserve), ["list"]);
});

test("Instance observation, management and event publication are separate contracts", () => {
    const observe = {
        list: async () => [],
        snapshot: async () => snapshot,
        refresh: async () => snapshot,
        readLogs: async () => [],
        watchEvents: async () => {},
    } satisfies ExtensionInstanceObserveCapability;
    const manage = {
        create: async () => ({ enabled: true, name: "example" }),
        createSchema: async () => ({}),
        validateCreate: async () => ({}),
        delete: async () => {},
        disable: async () => {},
        enable: async () => {},
        start: async () => snapshot,
        stop: async () => snapshot,
    } satisfies ExtensionInstanceManageCapability;
    const eventPublish = {
        appendEvent: async () => {},
    } satisfies ExtensionInstanceEventPublishCapability;

    assert.deepEqual(Object.keys(observe).sort(), [
        "list",
        "readLogs",
        "refresh",
        "snapshot",
        "watchEvents",
    ]);
    assert.deepEqual(Object.keys(manage).sort(), [
        "create",
        "createSchema",
        "delete",
        "disable",
        "enable",
        "start",
        "stop",
        "validateCreate",
    ]);
    assert.deepEqual(Object.keys(eventPublish), ["appendEvent"]);

    const capabilities: ExtensionCapabilities = {
        contextObserve: { list: async () => [] },
        instanceEventPublish: eventPublish,
        instanceManage: manage,
        instanceObserve: observe,
    };
    assert.deepEqual(Object.keys(capabilities).sort(), [
        "contextObserve",
        "instanceEventPublish",
        "instanceManage",
        "instanceObserve",
    ]);
});

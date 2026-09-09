import assert from "node:assert/strict";
import test from "node:test";

import { ExtensionInstanceCapabilityControl } from "../../../src/control/extension/host/generation/capability/ExtensionInstanceCapabilityControl.ts";
import type { InstanceDescriptor } from "../../../src/control/instance/InstanceDescriptor.ts";
import { InstanceRegistry } from "../../../src/control/instance/registry/InstanceRegistry.ts";
import { RuntimeSubscriptionManager } from "../../../src/instance/runtime/RuntimeSubscriptionManager.ts";

test("Instance capability watchEvents filters authoritative runtime events and stops on cancellation", async () => {
    let subscriptions = 0;
    const worker = {
        subscribe(fromSeq: number) {
            assert.equal(fromSeq, 1);
            subscriptions += 1;
            if (subscriptions === 1) return { events: [], kind: "events" as const, lastSeq: 0 };
            return {
                events: [
                    { at: "now", instanceName: "demo-local", seq: 1, type: "log.appended" },
                    { at: "now", instanceName: "demo-local", seq: 1, type: "instance.readyChanged" }
                ],
                kind: "events" as const,
                lastSeq: 1
            };
        }
    };
    const instances = new InstanceRegistry([{
        name: "demo-local",
        worker
    } as unknown as InstanceDescriptor]);
    const capability = new ExtensionInstanceCapabilityControl({
        allowed: true,
        create: {
            async createInstance() { throw new Error("unused"); },
            getSchema() { return {} as never; },
            validateDraft() { return {} as never; }
        },
        editor: {
            async deleteInstance() { throw new Error("unused"); },
            async disableInstance() { throw new Error("unused"); },
            async enableInstance() { throw new Error("unused"); }
        },
        extensionId: "instance",
        instances,
        listConfigured: () => [{ enabled: true, mcpEnabled: true, name: "demo-local", provider: "local" }],
        subscriptions: new RuntimeSubscriptionManager(1)
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
        signal: controller.signal
    });

    assert.deepEqual(events, ["1:log.appended"]);
    assert.ok(subscriptions >= 2);
});

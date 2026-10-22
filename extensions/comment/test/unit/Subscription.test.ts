import assert from "node:assert/strict";
import test from "node:test";
import type { ControlStreamMessage } from "@portable-devshell/extension/control";
import type { ExtensionInstanceEventWatch } from "@portable-devshell/extension/instance";
import { createMessageSubscriptionBinding } from "../../src/message/Route.ts";

test("message subscription preserves seed, report projection, gap cursor, and cancellation", async () => {
    const messages: ControlStreamMessage[] = [];
    const controller = new AbortController();
    const event = (seq: number, type: string, data = {}) => ({ at: "now", instanceName: "dev", seq, type, data });
    const binding = createMessageSubscriptionBinding({
        async watchEvents(instance, watch) {
            assert.equal(instance, "dev");
            assert.equal(watch.fromSeq, 1);
            assert.equal(watch.signal, controller.signal);
            assert.equal(typeof watch.onSeed, "function");
            await watch.onSeed!({
                events: [event(1, "log.appended"), event(2, "context.message.queued"), event(3, "toolCall.completed", { toolName: "progress_report" })],
                lastSeq: 3,
            });
            await watch.onEvent(event(4, "toolCall.completed", { toolName: "bash_run" }));
            await watch.onEvent(event(5, "context.message.delivered"));
            await watch.onGap!({ lastSeq: 12, nextSeq: 10 });
            await watch.onEvent(event(10, "toolCall.completed", { toolName: "progress_report" }));
            controller.abort();
            assert.equal(watch.signal.aborted, true);
        },
    });
    await binding({ send: async (message) => { messages.push(message); }, close: async () => {} },
        { payload: { fromSeq: 1 } },
        { destination: "dev", peer: "cli", requestId: "request", signal: controller.signal });
    assert.deepEqual(messages, [
        { name: "seed", payload: { events: [event(2, "context.message.queued"), event(3, "message.changed", { toolName: "progress_report" })], lastSeq: 3 } },
        { name: "event", payload: event(5, "context.message.delivered"), seq: 5 },
        { name: "gap", payload: { instance: "dev", latestSeq: 12, oldestAvailableSeq: 10, requestedFromSeq: 6 }, seq: 12 },
        { name: "event", payload: event(10, "message.changed", { toolName: "progress_report" }), seq: 10 },
    ]);
});

test("invalid message cursor fails before observing the instance", async () => {
    let observed = false;
    const binding = createMessageSubscriptionBinding({
        async watchEvents(_instance: string, _watch: ExtensionInstanceEventWatch) { observed = true; },
    });
    await assert.rejects(async () => await binding({ send: async () => {}, close: async () => {} },
        { payload: { fromSeq: -1 } },
        { destination: "dev", peer: "cli", requestId: "request", signal: new AbortController().signal }),
    { code: "control.invalidTarget" });
    assert.equal(observed, false);
});

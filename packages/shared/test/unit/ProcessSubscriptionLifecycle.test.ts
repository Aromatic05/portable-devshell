import assert from "node:assert/strict";
import test from "node:test";

import type { ControlPortContext } from "../../src/control/server/Route.ts";
import type { InstanceEventRecord } from "../../src/client/Stream.ts";
import { ProcessSubscriptionManager } from "../../src/execution/process/Subscription.ts";
import type { MessageStream } from "../../src/transport/packet/Stream.ts";
import { asInstanceName } from "../../src/types/Instance.ts";

function event(seq: number): InstanceEventRecord {
    return {
        at: "2026-11-01T00:00:00Z",
        instanceName: asInstanceName("alpha"),
        seq,
        type: "toolCall.completed",
    };
}

async function until(condition: () => boolean): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (!condition()) {
        assert.ok(Date.now() < deadline, "Subscription did not terminate");
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }
}

for (const failure of ["send", "source"] as const) {
    test(`a ${failure} failure terminates the subscriber stream so the client can resume`, async (t) => {
        const manager = new ProcessSubscriptionManager(2);
        t.after(() => manager.close());
        const events: InstanceEventRecord[] = [];
        let failSource = false;
        let failSend = false;
        const source = {
            subscribe(fromSeq = 1) {
                if (failSource) throw new Error("Audit event source failed");
                return {
                    events: events.filter((item) => item.seq >= fromSeq),
                    kind: "events" as const,
                    lastSeq: events.length,
                };
            },
        };
        const messages: Array<{ name: string; payload?: { events: InstanceEventRecord[] } }> = [];
        let terminated = 0;
        const stream = {
            async send(message: { name: string; payload?: { events: InstanceEventRecord[] } }) {
                if (failSend) throw new Error("Stream send failed");
                messages.push(message);
            },
            onClose: () => () => undefined,
            onCancel: () => () => undefined,
            async close() { terminated++; },
            async cancel() { terminated++; },
        } as unknown as MessageStream;
        const context = (id: string) => ({ connectionId: id, requestId: id }) as ControlPortContext;

        await manager.subscribe(stream, context("first"), "alpha", source, 1);
        failSource = failure === "source";
        failSend = failure === "send";
        events.push(event(1));
        await until(() => terminated === 1);
        assert.deepEqual(messages.map((message) => message.name), ["seed"]);

        failSource = false;
        failSend = false;
        events.push(event(2));
        const replay: typeof messages = [];
        const resumedStream = {
            ...stream,
            async send(message: (typeof messages)[number]) { replay.push(message); },
        } as MessageStream;
        await manager.subscribe(resumedStream, context("resumed"), "alpha", source, 1);
        assert.deepEqual(replay[0]?.payload?.events.map((item) => item.seq), [1, 2]);
    });
}

test("instance retirement terminates active subscriber streams without waiting for another event", async () => {
    const manager = new ProcessSubscriptionManager(2);
    let terminated = 0;
    const stream = {
        async send() {},
        onClose: () => () => undefined,
        onCancel: () => () => undefined,
        async close() { terminated++; },
        async cancel() { terminated++; },
    } as unknown as MessageStream;
    await manager.subscribe(
        stream,
        { connectionId: "first", requestId: "first" } as ControlPortContext,
        "alpha",
        { subscribe: () => ({ events: [], kind: "events", lastSeq: 0 }) },
        1,
    );
    manager.close();
    await until(() => terminated === 1);
});

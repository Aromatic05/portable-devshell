import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    ClientStream,
    InstanceEventStream,
    type ClientEvent,
} from "@portable-devshell/shared";

function event(seq: number, type = "log.appended") {
    return {
        at: `2026-08-06T00:00:0${seq}.000Z`,
        instanceName: asInstanceName("alpha"),
        seq,
        type,
    } as const;
}

test("instance event stream decodes initial and live events through one domain stream", async () => {
    const queue: ClientEvent[] = [
        {
            destination: asInstanceName("alpha"),
            id: "live-2",
            name: "instanceEvent.published",
            payload: event(2, "context.message.delivered"),
            seq: 2,
            streamId: "stream-1",
        },
        {
            destination: asInstanceName("alpha"),
            id: "gap",
            name: "stream.gap",
            payload: {
                latestSeq: 5,
                oldestAvailableSeq: 4,
                requestedFromSeq: 2,
            },
            streamId: "stream-1",
        },
        {
            destination: asInstanceName("alpha"),
            id: "closed",
            name: "stream.cancelled",
            streamId: "stream-1",
        },
    ];
    const stream = new ClientStream("stream-1", {
        close() {},
        async nextEvent() {
            const next = queue.shift();
            if (next === undefined) throw new Error("No event.");
            return next;
        },
        async send() {},
    });
    const runtime = new InstanceEventStream(
        asInstanceName("alpha"),
        {
            acknowledgement: {
                destination: asInstanceName("alpha"),
                id: "ack",
                name: "runtime.subscribe",
                payload: { events: [event(1)] },
                streamId: "stream-1",
            },
            stream,
        },
    );

    assert.deepEqual(await runtime.next(), { event: event(1), kind: "event" });
    assert.deepEqual(await runtime.next(), {
        event: event(2, "context.message.delivered"),
        kind: "event",
    });
    assert.deepEqual(await runtime.next(), {
        details: {
            latestSeq: 5,
            oldestAvailableSeq: 4,
            requestedFromSeq: 2,
        },
        fromSeq: 2,
        kind: "gap",
        lastSeq: 5,
        nextSeq: 4,
    });
    assert.deepEqual(await runtime.next(), { kind: "closed" });
});


test("instance event stream preserves remote cancellation error metadata", async () => {
    const stream = new ClientStream("stream-1", {
        close() {},
        async nextEvent() {
            return {
                destination: asInstanceName("alpha"),
                error: {
                    code: "stream.remoteCancelled",
                    message: "remote stopped",
                    retryable: true,
                },
                id: "cancelled",
                name: "stream.cancelled",
                streamId: "stream-1",
            };
        },
        async send() {},
    });
    const runtime = new InstanceEventStream(asInstanceName("alpha"), {
        acknowledgement: {
            destination: asInstanceName("alpha"),
            id: "ack",
            name: "runtime.subscribe",
            payload: { events: [] },
            streamId: "stream-1",
        },
        stream,
    });

    const message = await runtime.next();
    assert.equal(message.kind, "closed");
    assert.equal(
        message.kind === "closed"
            ? (message.error as { code?: string } | undefined)?.code
            : undefined,
        "stream.remoteCancelled",
    );
    assert.equal(
        message.kind === "closed"
            ? (message.error as { retryable?: boolean } | undefined)?.retryable
            : undefined,
        true,
    );
});

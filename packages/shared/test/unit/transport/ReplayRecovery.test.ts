import assert from "node:assert/strict";
import test from "node:test";

import {
    EventSubscription,
    type EventStreamPort,
    type StreamMessage,
} from "../../../src/client/Stream.ts";

test("event reconnect requests the next cursor and stop closes the resumed replay", { timeout: 5_000 }, async (t) => {
    const opened: number[] = [];
    const delivered: number[] = [];
    const closed: number[] = [];
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => { finish = resolve; });
    const subscription = new EventSubscription<number>(5, {
        eventSeq: (event) => event,
        readGapError: () => undefined,
        onGap: () => { assert.fail("continuous replay must not report a gap"); },
        onEvent: (event) => {
            delivered.push(event);
            if (event === 7) finish();
        },
        retryBaseMs: 1,
        async open(cursor): Promise<EventStreamPort<number>> {
            opened.push(cursor);
            assert.ok(opened.length <= 2, "stop must prevent further reconnects");
            const messages: StreamMessage<number>[] = cursor === 5
                ? [{ kind: "event", event: 5 }, { kind: "event", event: 6 }, { kind: "closed" }]
                : [{ kind: "event", event: 7 }];
            let waiting: ((message: StreamMessage<number>) => void) | undefined;
            let isClosed = false;
            return {
                async next() {
                    const message = messages.shift();
                    return message ?? await new Promise<StreamMessage<number>>((resolve) => { waiting = resolve; });
                },
                close() {
                    if (isClosed) return;
                    isClosed = true;
                    closed.push(cursor);
                    waiting?.({ kind: "closed" });
                },
            };
        },
    });
    t.after(() => subscription.stop());
    subscription.start();
    subscription.start();
    await finished;
    assert.deepEqual(opened, [5, 7]);
    assert.deepEqual(delivered, [5, 6, 7]);
    assert.equal(subscription.cursor, 8);
    subscription.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(subscription.status, "stopped");
    assert.deepEqual(closed, [5, 7]);
    assert.deepEqual(opened, [5, 7]);
});

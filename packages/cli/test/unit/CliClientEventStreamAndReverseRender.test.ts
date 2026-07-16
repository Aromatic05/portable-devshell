import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    ClientStream,
    errorCodes,
    type ClientEvent
} from "@portable-devshell/shared";

import {
    CliClientEventStream,
    createCliClientEventStream
} from "../../dist/client/CliClientEventStream.js";
import {
    renderReverseDeviceCode,
    renderReverseTokenRevocation,
    renderReverseTokenRotation
} from "../../dist/render/instance/CliRenderInstanceReverse.js";

const destination = asInstanceName("demo-local");

test("CLI event stream drains acknowledgement events before reading the live stream", async () => {
    const liveEvents: ClientEvent[] = [event("live", "instance.started")];
    let liveReads = 0;
    const stream = new ClientStream("stream-1", {
        close() {},
        async nextEvent() {
            liveReads += 1;
            return liveEvents.shift()!;
        },
        async send() {}
    });
    const wrapped = new CliClientEventStream(stream, [
        event("initial-1", "instance.statusChanged"),
        event("initial-2", "instance.readyChanged")
    ]);

    assert.equal((await wrapped.nextEvent()).id, "initial-1");
    assert.equal((await wrapped.nextEvent()).id, "initial-2");
    assert.equal(liveReads, 0);
    assert.equal((await wrapped.nextEvent()).id, "live");
    assert.equal(liveReads, 1);
});

test("CLI event stream maps gap and terminal stream events to actionable errors", async () => {
    const gap = createStreamWithEvent(event("gap", "stream.gap", { oldestSeq: 10 }));
    await assert.rejects(gap.nextEvent(), (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.streamGap);
        assert.equal(readField(error, "retryable"), true);
        assert.deepEqual(readField(error, "details"), { oldestSeq: 10 });
        return true;
    });

    const cancelled = createStreamWithEvent({
        ...event("cancelled", "stream.cancelled"),
        error: {
            code: "stream.remoteCancelled",
            message: "remote stopped",
            retryable: true
        }
    });
    await assert.rejects(cancelled.nextEvent(), (error: unknown) => {
        assert.equal(readField(error, "code"), "stream.remoteCancelled");
        assert.equal(readField(error, "retryable"), true);
        return true;
    });

    await assert.rejects(
        createStreamWithEvent(event("cancelled", "stream.cancelled")).nextEvent(),
        /control stream was cancelled/u
    );
    await assert.rejects(
        createStreamWithEvent(event("completed", "stream.completed")).nextEvent(),
        /control stream completed/u
    );
});

test("CLI event stream closes the underlying stream and converts acknowledgement payloads", async () => {
    let closed = 0;
    const stream = new ClientStream("stream-1", {
        close() {
            closed += 1;
        },
        async nextEvent() {
            return event("live", "instance.started");
        },
        async send() {}
    });
    const wrapped = createCliClientEventStream("demo-local", {
        acknowledgement: {
            destination,
            id: "ack",
            name: "runtime.subscribe",
            payload: {
                events: [
                    {
                        at: "2026-07-16T00:00:00.000Z",
                        instanceName: "demo-local",
                        seq: 4,
                        type: "instance.started"
                    }
                ]
            },
            streamId: "stream-1"
        },
        stream
    });

    const initial = await wrapped.nextEvent();
    assert.equal(initial.id, "initial-4");
    assert.equal(initial.destination, destination);
    assert.equal(initial.name, "instance.started");
    assert.equal(initial.seq, 4);

    wrapped.close();
    wrapped.close();
    assert.equal(closed, 1);
});

test("reverse CLI renderers include copyable enrollment and credential instructions", () => {
    assert.equal(
        renderReverseDeviceCode({
            controllerUrl: "https://controller.example/base",
            deviceCode: "ABCD-EFGH",
            expiresAt: "2026-07-16T12:00:00.000Z",
            instance: "reverse-one"
        }),
        [
            "instance: reverse-one",
            "device code: ABCD-EFGH",
            "expires: 2026-07-16T12:00:00.000Z",
            "enroll: devshell-worker enroll --controller https://controller.example/base --device-code ABCD-EFGH",
            ""
        ].join("\n")
    );
    assert.match(
        renderReverseTokenRotation({ deviceToken: "new-secret", instance: "reverse-one" }),
        /new device token: new-secret[\s\S]*Update the remote worker credential/u
    );
    assert.equal(
        renderReverseTokenRevocation({ instance: "reverse-one", revoked: true }),
        "instance: reverse-one\ndevice token revoked\n"
    );
});

function createStreamWithEvent(next: ClientEvent): CliClientEventStream {
    return new CliClientEventStream(
        new ClientStream("stream-1", {
            close() {},
            async nextEvent() {
                return next;
            },
            async send() {}
        }),
        []
    );
}

function event(id: string, name: ClientEvent["name"], payload?: ClientEvent["payload"]): ClientEvent {
    return {
        destination,
        id,
        name,
        ...(payload === undefined ? {} : { payload })
    };
}

function readField(value: unknown, field: string): unknown {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return (value as Record<string, unknown>)[field];
}

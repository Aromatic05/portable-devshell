import assert from "node:assert/strict";
import test from "node:test";

import {
    asInstanceName,
    errorCodes,
    type InstanceEventStreamPort,
    type InstanceStreamMessage
} from "@portable-devshell/shared";

import { CliClientEventStream } from "../../src/client/CliClientEventStream.ts";

const destination = asInstanceName("demo-local");

test("CLI event stream forwards shared instance events", async () => {
    const wrapped = new CliClientEventStream(
        stream({
            event: {
                at: "2026-07-16T00:00:00.000Z",
                instanceName: destination,
                seq: 4,
                type: "instance.started",
            },
            kind: "event",
        }),
    );

    const event = await wrapped.nextEvent();
    assert.equal(event.instanceName, destination);
    assert.equal(event.seq, 4);
    assert.equal(event.type, "instance.started");
});

test("CLI event stream maps gaps and terminal closure to actionable errors", async () => {
    const gap = new CliClientEventStream(
        stream({
            details: {
                latestSeq: 20,
                oldestAvailableSeq: 10,
                requestedFromSeq: 2,
            },
            fromSeq: 2,
            kind: "gap",
            lastSeq: 20,
            nextSeq: 10,
        }),
    );
    await assert.rejects(gap.nextEvent(), (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.streamGap);
        assert.equal(readField(error, "retryable"), true);
        assert.deepEqual(readField(error, "details"), {
            latestSeq: 20,
            oldestAvailableSeq: 10,
            requestedFromSeq: 2,
        });
        return true;
    });

    const remote = Object.assign(new Error("remote stopped"), {
        code: "stream.remoteCancelled",
        retryable: true,
    });
    await assert.rejects(
        new CliClientEventStream(stream({ error: remote, kind: "closed" }))
            .nextEvent(),
        (error: unknown) => {
            assert.equal(error, remote);
            assert.equal(readField(error, "code"), "stream.remoteCancelled");
            assert.equal(readField(error, "retryable"), true);
            return true;
        },
    );
    await assert.rejects(
        new CliClientEventStream(stream({ kind: "closed" })).nextEvent(),
        /control stream completed/u,
    );
});

test("CLI event stream closes the shared stream once", () => {
    let closed = 0;
    const wrapped = new CliClientEventStream({
        close() {
            closed += 1;
        },
        async next() {
            return { kind: "closed" };
        },
    });

    wrapped.close();
    wrapped.close();
    assert.equal(closed, 1);
});

function stream(message: InstanceStreamMessage): InstanceEventStreamPort {
    return {
        close() {},
        async next() {
            return message;
        },
    };
}

function readField(value: unknown, field: string): unknown {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return (value as Record<string, unknown>)[field];
}

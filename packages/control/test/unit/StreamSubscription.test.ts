import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";
import type { JsonValue, PrefixRouteContext, PrefixRouteStream } from "@portable-devshell/shared";

import { RuntimeSubscriptionManager } from "../../dist/instance/runtime/RuntimeSubscriptionManager.js";

test("RuntimeSubscriptionManager returns snapshot lastSeq and pushes sequenced events", async () => {
    const manager = new RuntimeSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");

    const harness = createStreamContext("conn-1", "subscribe-1");

    await manager.subscribe(
        harness.context,
        "alpha",
        worker as unknown as WorkerInstance,
        1
    );

    assert.equal((harness.initialPayload as { lastSeq?: number })?.lastSeq, 1);
    assert.equal((harness.initialPayload as { events?: Array<{ seq: number }> })?.events?.[0]?.seq, 1);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await waitFor(() => harness.events.length === 1);

    assert.equal(harness.events[0]?.seq, 2);
    assert.equal(harness.events[0]?.module, "toolCall");
    assert.equal(harness.events[0]?.name, "completed");
    assert.equal((harness.events[0]?.payload as { seq?: number }).seq, 2);
    manager.unsubscribeConnection("conn-1");
});

test("RuntimeSubscriptionManager returns stream.gap when fromSeq is unavailable", async () => {
    const manager = new RuntimeSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(2);

    await assert.rejects(
        manager.subscribe(
            createStreamContext("conn-2", "subscribe-2").context,
            "alpha",
            worker as unknown as WorkerInstance,
            1
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "stream.gap");
            assert.equal((error as { retryable?: boolean }).retryable, true);
            assert.deepEqual((error as { details?: Record<string, unknown> }).details, {
                instance: "alpha",
                latestSeq: 2,
                oldestAvailableSeq: 2,
                requestedFromSeq: 1
            });
            return true;
        }
    );
    manager.unsubscribeConnection("conn-2");
});

test("RuntimeSubscriptionManager emits a non-terminal runtime stream.gap", async () => {
    const manager = new RuntimeSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");

    const harness = createStreamContext("conn-3", "subscribe-3");

    await manager.subscribe(harness.context, "alpha", worker as unknown as WorkerInstance, 1);
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await waitFor(() => harness.events.length === 1);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(4);
    await waitFor(() => harness.events.length === 2);

    assert.equal(harness.events[1]?.module, "stream");
    assert.equal(harness.events[1]?.name, "gap");
    assert.deepEqual(harness.events[1]?.payload, {
        instance: "alpha",
        latestSeq: 3,
        oldestAvailableSeq: 4,
        requestedFromSeq: 3
    });
    manager.unsubscribeConnection("conn-3");
});

function createStreamContext(connectionId: string, requestId: string): {
    context: PrefixRouteContext;
    events: Array<{ module?: string; name: string; payload?: JsonValue; seq?: number }>;
    initialPayload?: JsonValue;
} {
    const result: {
        context: PrefixRouteContext;
        events: Array<{ module?: string; name: string; payload?: JsonValue; seq?: number }>;
        initialPayload?: JsonValue;
    } = {
        context: undefined as unknown as PrefixRouteContext,
        events: []
    };
    const stream: PrefixRouteStream = {
        id: requestId,
        async cancel() {},
        async complete() {},
        async emit(name, payload, seq, module) {
            result.events.push({
                ...(module === undefined ? {} : { module }),
                name,
                ...(payload === undefined ? {} : { payload }),
                ...(seq === undefined ? {} : { seq })
            });
        }
    };
    result.context = {
        afterReply() {},
        connectionId,
        destination: "alpha" as never,
        module: "runtime",
        async openStream(initialPayload) {
            result.initialPayload = initialPayload;
            return stream;
        },
        peer: "cli",
        requestId,
        signal: new AbortController().signal
    };
    return result;
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{ at: string; data?: unknown; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;
    #snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 0,
        name: "alpha",
        ready: false,
        status: "stopped"
    };

    constructor(name: string) {
        this.#name = name;
        this.#snapshot = {
            ...this.#snapshot,
            name
        };
    }

    async start(_workspacePath?: string) {
        this.emit("instance.started", { workspacePath: "/tmp/ws" });
        this.#snapshot = {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: this.#name,
            ready: true,
            status: "ready"
        };
        return this.snapshot();
    }

    snapshot() {
        return this.#snapshot;
    }

    subscribe(fromSeq = 1) {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;

        if (fromSeq < nextSeq) {
            return {
                code: "stream.gap",
                fromSeq,
                kind: "gap" as const,
                lastSeq: this.#lastSeq,
                nextSeq
            };
        }

        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq
        };
    }

    emit(type: string, data?: unknown) {
        const event = {
            at: new Date().toISOString(),
            data,
            instanceName: this.#name,
            seq: this.#lastSeq + 1,
            type
        };

        this.#lastSeq = event.seq;
        this.#events.push(event);
        this.#snapshot = {
            ...this.#snapshot,
            lastSeq: this.#lastSeq
        };
    }

    dropBefore(seq: number) {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 500;

    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for streamed event.");
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

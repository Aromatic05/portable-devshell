import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core/testing";
import type { JsonValue, PrefixRouteContext, PrefixRouteStream } from "@portable-devshell/shared";

import { RuntimeSubscriptionManager } from "../../src/instance/runtime/RuntimeSubscriptionManager.ts";

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

test("RuntimeSubscriptionManager preserves dotted context message operations", async () => {
    const manager = new RuntimeSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");
    const harness = createStreamContext("conn-context", "subscribe-context");

    await manager.subscribe(
        harness.context,
        "alpha",
        worker as unknown as WorkerInstance,
        1,
    );
    worker.emit("context.message.delivered", {
        ctxId: "ctx-a",
        id: "message-a",
        status: "delivered",
    });
    await waitFor(() => harness.events.length === 1);

    assert.equal(harness.events[0]?.module, "context");
    assert.equal(harness.events[0]?.name, "message.delivered");
    assert.equal(
        (harness.events[0]?.payload as { data?: { ctxId?: string } }).data
            ?.ctxId,
        "ctx-a",
    );
    manager.unsubscribeConnection("conn-context");
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

test("RuntimeSubscriptionManager does not overlap polls while an event emit is pending", async () => {
    const manager = new RuntimeSubscriptionManager(1);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");
    let emitCount = 0;
    let releaseFirstEmit!: () => void;
    const firstEmitStarted = new Promise<void>((resolve) => {
        releaseFirstEmit = resolve;
    });
    let signalFirstEmit!: () => void;
    const emitStarted = new Promise<void>((resolve) => {
        signalFirstEmit = resolve;
    });
    const harness = createStreamContext("conn-4", "subscribe-4", async () => {
        emitCount += 1;
        if (emitCount === 1) {
            signalFirstEmit();
            await firstEmitStarted;
        }
    });

    await manager.subscribe(harness.context, "alpha", worker as unknown as WorkerInstance, 1);
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await emitStarted;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(emitCount, 1);
    releaseFirstEmit();
    await waitFor(() => harness.events.length === 1);
    manager.unsubscribeConnection("conn-4");
});

test("RuntimeSubscriptionManager isolates a throwing subscription poll", async () => {
    const manager = new RuntimeSubscriptionManager(1);
    const badWorker = new FakeWorker("bad");
    const healthyWorker = new FakeWorker("healthy");
    await Promise.all([badWorker.start("/tmp/ws"), healthyWorker.start("/tmp/ws")]);
    let failPoll = false;
    const throwingWorker = {
        subscribe(fromSeq: number) {
            if (failPoll) {
                throw new Error("bad instance subscription");
            }
            return badWorker.subscribe(fromSeq);
        }
    };
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const bad = createStreamContext("conn-bad", "subscribe-bad");
    const healthy = createStreamContext("conn-healthy", "subscribe-healthy");

    try {
        await manager.subscribe(bad.context, "bad", throwingWorker as WorkerInstance, 1);
        await manager.subscribe(healthy.context, "healthy", healthyWorker as unknown as WorkerInstance, 1);
        failPoll = true;
        healthyWorker.emit("toolCall.completed", { toolName: "bash_run" });

        await waitFor(() => healthy.events.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(unhandled.length, 0);
        assert.equal(healthy.events[0]?.seq, 2);
    } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        manager.unsubscribeConnection("conn-bad");
        manager.unsubscribeConnection("conn-healthy");
    }
});

function createStreamContext(
    connectionId: string,
    requestId: string,
    beforeEmit?: () => Promise<void>
): {
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
            await beforeEmit?.();
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
    const deadline = Date.now() + 2_000;

    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error("Timed out waiting for streamed event.");
        }

        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

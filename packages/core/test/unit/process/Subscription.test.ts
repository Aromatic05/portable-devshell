import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "../../../src/instance/runtime/index.ts";
import type {
    ControlPortContext,
    ControlStreamMessage,
    JsonValue,
    MessageStream,
} from "@portable-devshell/shared";

import { ProcessSubscriptionManager } from "../../../src/instance/runtime/supervision/Subscription.ts";

test("ProcessSubscriptionManager returns snapshot lastSeq and pushes sequenced events", async () => {
    const manager = new ProcessSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start();

    const harness = createStreamContext("conn-1", "subscribe-1");

    await manager.subscribe(
        harness.stream,
        harness.context,
        "alpha",
        worker as unknown as WorkerInstance,
        1,
    );

    assert.equal(harness.messages[0]?.name, "seed");
    assert.equal(
        (harness.messages[0]?.payload as { lastSeq?: number })?.lastSeq,
        1,
    );
    assert.equal(
        (harness.messages[0]?.payload as { events?: Array<{ seq: number }> })
            ?.events?.[0]?.seq,
        1,
    );

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await waitFor(() => harness.messages.length === 2);

    assert.equal(harness.messages[1]?.name, "event");
    assert.equal(harness.messages[1]?.seq, 2);
    assert.equal((harness.messages[1]?.payload as { seq?: number }).seq, 2);
    manager.unsubscribeConnection("conn-1");
});

test("ProcessSubscriptionManager transports multi-segment event types through valid route segments", async () => {
    const manager = new ProcessSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start();
    const harness = createStreamContext("conn-context", "subscribe-context");

    await manager.subscribe(
        harness.stream,
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
    await waitFor(() => harness.messages.length === 2);

    assert.equal(harness.messages[1]?.name, "event");
    assert.equal(
        (harness.messages[1]?.payload as { data?: { ctxId?: string } }).data
            ?.ctxId,
        "ctx-a",
    );
    manager.unsubscribeConnection("conn-context");
});

test("ProcessSubscriptionManager returns stream.gap when fromSeq is unavailable", async () => {
    const manager = new ProcessSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start();
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(2);

    const harness = createStreamContext("conn-2", "subscribe-2");
    await assert.rejects(
        manager.subscribe(
            harness.stream,
            harness.context,
            "alpha",
            worker as unknown as WorkerInstance,
            1,
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "stream.gap");
            assert.equal((error as { retryable?: boolean }).retryable, true);
            assert.deepEqual(
                (error as { details?: Record<string, unknown> }).details,
                {
                    instance: "alpha",
                    latestSeq: 2,
                    oldestAvailableSeq: 2,
                    requestedFromSeq: 1,
                },
            );
            return true;
        },
    );
    manager.unsubscribeConnection("conn-2");
});

test("ProcessSubscriptionManager emits a non-terminal runtime stream.gap", async () => {
    const manager = new ProcessSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start();

    const harness = createStreamContext("conn-3", "subscribe-3");

    await manager.subscribe(
        harness.stream,
        harness.context,
        "alpha",
        worker as unknown as WorkerInstance,
        1,
    );
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await waitFor(() => harness.messages.length === 2);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(4);
    await waitFor(() => harness.messages.length === 3);

    assert.equal(harness.messages[2]?.name, "gap");
    assert.deepEqual(harness.messages[2]?.payload, {
        instance: "alpha",
        latestSeq: 3,
        oldestAvailableSeq: 4,
        requestedFromSeq: 3,
    });
    manager.unsubscribeConnection("conn-3");
});

test("ProcessSubscriptionManager does not overlap polls while an event emit is pending", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const manager = new ProcessSubscriptionManager(1);
    const worker = new FakeWorker("alpha");
    await worker.start();
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

    await manager.subscribe(
        harness.stream,
        harness.context,
        "alpha",
        worker as unknown as WorkerInstance,
        1,
    );
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    t.mock.timers.tick(1);
    await emitStarted;
    t.mock.timers.tick(10);

    assert.equal(emitCount, 1);
    releaseFirstEmit();
    await waitFor(() => harness.messages.length === 2);
    manager.unsubscribeConnection("conn-4");
});

test("ProcessSubscriptionManager isolates a throwing subscription poll", async (t) => {
    t.mock.timers.enable({ apis: ["setInterval"] });
    const manager = new ProcessSubscriptionManager(1);
    const badWorker = new FakeWorker("bad");
    const healthyWorker = new FakeWorker("healthy");
    await Promise.all([badWorker.start(), healthyWorker.start()]);
    let failPoll = false;
    const throwingWorker = {
        subscribe(fromSeq: number) {
            if (failPoll) {
                throw new Error("bad instance subscription");
            }
            return badWorker.subscribe(fromSeq);
        },
    };
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);
    const bad = createStreamContext("conn-bad", "subscribe-bad");
    const healthy = createStreamContext("conn-healthy", "subscribe-healthy");

    try {
        await manager.subscribe(
            bad.stream,
            bad.context,
            "bad",
            throwingWorker as WorkerInstance,
            1,
        );
        await manager.subscribe(
            healthy.stream,
            healthy.context,
            "healthy",
            healthyWorker as unknown as WorkerInstance,
            1,
        );
        failPoll = true;
        healthyWorker.emit("toolCall.completed", { toolName: "bash_run" });
        t.mock.timers.tick(1);

        await waitFor(() => healthy.messages.length === 2);
        await new Promise<void>((resolve) => setImmediate(resolve));

        assert.equal(unhandled.length, 0);
        assert.equal(healthy.messages[1]?.seq, 2);
    } finally {
        process.off("unhandledRejection", onUnhandledRejection);
        manager.unsubscribeConnection("conn-bad");
        manager.unsubscribeConnection("conn-healthy");
    }
});

test("ProcessSubscriptionManager shares the same polling owner with callback watches and stops on abort", async () => {
    const manager = new ProcessSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start();
    const controller = new AbortController();
    const events: number[] = [];

    const watch = manager.watch(
        "alpha",
        worker as unknown as WorkerInstance,
        2,
        controller.signal,
        {
            onEvent(event) {
                events.push(event.seq);
            },
            onGap() {},
        },
    );
    worker.emit("todo.updated", { taskId: "task-a" });
    await waitFor(() => events.length === 1);
    controller.abort();
    await watch;

    assert.deepEqual(events, [2]);
});

function createStreamContext(
    connectionId: string,
    requestId: string,
    beforeSend?: () => Promise<void>,
): {
    context: ControlPortContext;
    messages: ControlStreamMessage[];
    stream: MessageStream;
} {
    const messages: ControlStreamMessage[] = [];
    const closeListeners = new Set<() => void>();
    const cancelListeners = new Set<() => void>();
    const fake = {
        async send(message: ControlStreamMessage) {
            if (message.name !== "seed") await beforeSend?.();
            messages.push(message);
        },
        onClose(listener: () => void) {
            closeListeners.add(listener);
            return () => closeListeners.delete(listener);
        },
        onCancel(listener: () => void) {
            cancelListeners.add(listener);
            return () => cancelListeners.delete(listener);
        },
    } as unknown as MessageStream;
    return {
        context: {
            afterReply() {},
            connectionId,
            host: "alpha",
            peer: "cli",
            requestId,
            signal: new AbortController().signal,
        },
        messages,
        stream: fake,
    };
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{
        at: string;
        data?: unknown;
        instanceName: string;
        seq: number;
        type: string;
    }> = [];
    #lastSeq = 0;
    #snapshot = {
        connectionState: "disconnected",
        daemonState: "stopped",
        lastSeq: 0,
        name: "alpha",
        ready: false,
        status: "stopped",
    };

    constructor(name: string) {
        this.#name = name;
        this.#snapshot = {
            ...this.#snapshot,
            name,
        };
    }

    async start() {
        this.emit("instance.started");
        this.#snapshot = {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: this.#name,
            ready: true,
            status: "ready",
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
                nextSeq,
            };
        }

        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq,
        };
    }

    emit(type: string, data?: unknown) {
        const event = {
            at: new Date().toISOString(),
            data,
            instanceName: this.#name,
            seq: this.#lastSeq + 1,
            type,
        };

        this.#lastSeq = event.seq;
        this.#events.push(event);
        this.#snapshot = {
            ...this.#snapshot,
            lastSeq: this.#lastSeq,
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

        await new Promise<void>((resolve) => setImmediate(resolve));
    }
}

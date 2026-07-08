import assert from "node:assert/strict";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";

import { StreamSubscriptionManager } from "../../dist/stream/StreamSubscriptionManager.js";

test("StreamSubscriptionManager returns snapshot lastSeq and pushes sequenced events", async () => {
    const manager = new StreamSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");

    const sentEvents: Array<Record<string, unknown>> = [];
    const connection = {
        id: "conn-1",
        async sendEvent(event: Record<string, unknown>) {
            sentEvents.push(event);
        }
    } as unknown as {
        id: string;
        sendEvent: (event: Record<string, unknown>) => Promise<void>;
    };

    const snapshot = (await manager.subscribe(
        connection as never,
        "alpha",
        worker as unknown as WorkerInstance,
        1
    )) as {
        events: Array<{ seq: number; type: string }>;
        lastSeq: number;
    };

    assert.equal(snapshot.lastSeq, 1);
    assert.equal(snapshot.events[0]?.seq, 1);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    await waitFor(() => sentEvents.length === 1);

    assert.equal(sentEvents[0]?.seq, 2);
    assert.equal(sentEvents[0]?.event, "toolCall.completed");
    assert.equal((sentEvents[0]?.payload as { seq?: number }).seq, 2);
    manager.unsubscribeConnection("conn-1");
});

test("StreamSubscriptionManager returns stream.gap when fromSeq is unavailable", async () => {
    const manager = new StreamSubscriptionManager(5);
    const worker = new FakeWorker("alpha");
    await worker.start("/tmp/ws");
    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(2);

    await assert.rejects(
        manager.subscribe(
            {
                id: "conn-2",
                async sendEvent() {}
            } as never,
            "alpha",
            worker as unknown as WorkerInstance,
            1
        ),
        (error: unknown) => {
            assert.equal((error as { code?: string }).code, "stream.gap");
            assert.equal((error as { retryable?: boolean }).retryable, true);
            return true;
        }
    );
    manager.unsubscribeConnection("conn-2");
});

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

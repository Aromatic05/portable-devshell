import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core/testing";
import {
    asInstanceName,
    ClientConnection,
    createError,
    SocketChannel,
    type JsonValue
} from "@portable-devshell/shared";

import { ControlRouteComposition } from "../../src/composition/ControlRouteComposition.ts";
import { ControlSocketServer } from "../../src/server/socket/ControlSocketServer.ts";
import { InstanceRegistry } from "../../src/control/instance/registry/InstanceRegistry.ts";
import { createTestIpcPath } from "../../../../test/TestPlatformSupport.ts";
import { createTestInstanceDescriptor } from "../ControlTestFixtures.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../test/TestCleanup.ts";

test("stream gap is non-terminal and the dedicated subscription remains usable", async (t) => {
    const directory = await createTestTempDirectory("stream-recovery");
    const socketPath = createTestIpcPath("stream-recovery", directory);
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started", { workspacePath: "/tmp/ws" });
    const registry = new InstanceRegistry([
        createTestInstanceDescriptor(worker as unknown as WorkerInstance, { name: "alpha" })
    ]);
    const routes = new ControlRouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const connection = await connect(socketPath);
    t.after(() => connection.close());
    const opened = await connection.openStream(
        asInstanceName("alpha"),
        "runtime",
        "subscribe",
        { fromSeq: 1 }
    );
    t.after(() => opened.stream.close());
    assert.equal(opened.acknowledgement.replyTo === undefined, false);
    assert.notEqual(opened.stream.id, opened.acknowledgement.replyTo);
    assert.deepEqual(opened.acknowledgement.payload, {
        events: [worker.events[0]],
        lastSeq: 1
    });

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    const normal = await opened.stream.nextEvent();
    assert.equal(normal.name, "toolCall.completed");
    assert.equal(normal.seq, 2);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(4);
    const gap = await opened.stream.nextEvent();
    assert.equal(gap.name, "stream.gap");
    assert.deepEqual(gap.payload, {
        instance: "alpha",
        latestSeq: 3,
        oldestAvailableSeq: 4,
        requestedFromSeq: 3
    });

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    const recovered = await opened.stream.nextEvent();
    assert.equal(recovered.name, "toolCall.completed");
    assert.equal(recovered.seq, 4);
});

test("an initial unavailable sequence returns a normal stream.gap error reply", async (t) => {
    const directory = await createTestTempDirectory("stream-initial-gap");
    const socketPath = createTestIpcPath("stream-recovery", directory);
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started", {});
    worker.emit("toolCall.completed", {});
    worker.dropBefore(2);
    const registry = new InstanceRegistry([
        createTestInstanceDescriptor(worker as unknown as WorkerInstance, { name: "alpha" })
    ]);
    const routes = new ControlRouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await cleanupInOrder(
            () => server.stop(),
            () => routes.dispose(),
            () => rm(directory, { force: true, recursive: true }),
        );
    });

    const connection = await connect(socketPath);
    t.after(() => connection.close());
    const reply = await connection.requestEvent(
        asInstanceName("alpha"),
        "runtime",
        "subscribe",
        { fromSeq: 1 }
    );
    assert.equal(reply.error?.code, "stream.gap");
    assert.equal(reply.error?.retryable, true);
    assert.deepEqual(reply.error?.details, {
        instance: "alpha",
        latestSeq: 2,
        oldestAvailableSeq: 2,
        requestedFromSeq: 1
    });
});

async function connect(socketPath: string): Promise<ClientConnection> {
    const connection = new ClientConnection({
        connectChannel: (signal) => SocketChannel.connect(socketPath, { signal }),
        mapError: (error) => error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "cli"
    });
    await connection.request("@control", "service", "hello", {
        clientKind: "cli",
        maxProtocolVersion: 1,
        minProtocolVersion: 1,
    });
    return connection;
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{ at: string; data?: JsonValue; instanceName: string; seq: number; type: string }> = [];
    #lastSeq = 0;

    constructor(name: string) {
        this.#name = name;
    }

    get events() {
        return this.#events;
    }

    snapshot() {
        return {
            connectionState: "connected",
            daemonState: "running",
            lastSeq: this.#lastSeq,
            name: asInstanceName(this.#name),
            ready: true,
            status: "ready"
        };
    }

    subscribe(fromSeq = 1) {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;
        if (fromSeq < nextSeq) {
            return { kind: "gap" as const, lastSeq: this.#lastSeq, nextSeq };
        }
        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events" as const,
            lastSeq: this.#lastSeq
        };
    }

    emit(type: string, data?: JsonValue) {
        const event = {
            at: new Date().toISOString(),
            ...(data === undefined ? {} : { data }),
            instanceName: this.#name,
            seq: ++this.#lastSeq,
            type
        };
        this.#events.push(event);
    }

    dropBefore(seq: number) {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

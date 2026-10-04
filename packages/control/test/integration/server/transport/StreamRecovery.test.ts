import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core/testing";
import {
    CONTROL_PROTOCOL_RANGE,
    Endpoint,
    LocalChannel,
    Rpc,
    Stream,
    asInstanceName,
    type ControlStreamMessage,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";

import { ControlRouteComposition } from "../../../../src/composition/Route.ts";
import { createTestInstanceDomainRuntime } from "../../../../src/testing.ts";
import { ControlSocketServer } from "../../../../src/server/transport/endpoint/Socket.ts";
import { InstanceRegistry } from "@portable-devshell/core";
import { createTestIpcPath } from "../../../../../../test/TestPlatformSupport.ts";
import { createTestInstanceDescriptor } from "../../../support/ControlFixtures.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";
import { cleanupInOrder } from "../../../../../../test/TestCleanup.ts";

test("stream gap is non-terminal and the dedicated subscription remains usable", async (t) => {
    const directory = await createTestTempDirectory("stream-recovery");
    const socketPath = createTestIpcPath("stream-recovery", directory);
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started");
    const registry = new InstanceRegistry([
        createTestInstanceDescriptor(worker as unknown as WorkerInstance, {
            name: "alpha",
        }),
    ]);
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: registry,
        shutdown() {},
    });
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
    const stream = await connection.open(
        asInstanceName("alpha"),
        "process",
        "subscribe",
        { fromSeq: 1 },
    );
    t.after(() => void stream.close());
    const seed = await readMessage(stream);
    assert.equal(seed.name, "seed");
    assert.deepEqual(seed.payload, {
        events: [worker.events[0]],
        lastSeq: 1,
    });

    worker.emit("instance.started");
    const normal = await readMessage(stream);
    assert.equal(normal.name, "event");
    assert.equal(normal.seq, 2);
    assert.equal(
        (normal.payload as { type?: string }).type,
        "instance.started",
    );

    worker.emit("instance.started");
    worker.dropBefore(4);
    const gap = await readMessage(stream);
    assert.equal(gap.name, "gap");
    assert.deepEqual(gap.payload, {
        instance: "alpha",
        latestSeq: 3,
        oldestAvailableSeq: 4,
        requestedFromSeq: 3,
    });

    worker.emit("instance.started");
    const recovered = await readMessage(stream);
    assert.equal(recovered.name, "event");
    assert.equal(recovered.seq, 4);
    assert.equal(
        (recovered.payload as { type?: string }).type,
        "instance.started",
    );
});

test("an initial unavailable sequence returns a normal stream.gap error reply", async (t) => {
    const directory = await createTestTempDirectory("stream-initial-gap");
    const socketPath = createTestIpcPath("stream-recovery", directory);
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started", {});
    worker.emit("toolCall.completed", {});
    worker.dropBefore(2);
    const registry = new InstanceRegistry([
        createTestInstanceDescriptor(worker as unknown as WorkerInstance, {
            name: "alpha",
        }),
    ]);
    const routes = new ControlRouteComposition({
        instanceDomains: createTestInstanceDomainRuntime(),
        instances: registry,
        shutdown() {},
    });
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
    const stream = await connection.open(
        asInstanceName("alpha"),
        "process",
        "subscribe",
        { fromSeq: 1 },
    );
    await assert.rejects(stream.readMessage(), (error: unknown) => {
        const value = error as Error & {
            code?: string;
            details?: unknown;
            retryable?: boolean;
        };
        assert.equal(value.code, "stream.gap");
        assert.equal(value.retryable, true);
        assert.deepEqual(value.details, {
            instance: "alpha",
            latestSeq: 2,
            oldestAvailableSeq: 2,
            requestedFromSeq: 1,
        });
        return true;
    });
});

interface TestConnection {
    close(): void;
    open(
        host: string,
        port: string,
        name: string,
        payload?: JsonValue,
    ): Promise<MessageStream>;
}

async function connect(socketPath: string): Promise<TestConnection> {
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(socketPath, { signal }),
    });
    const protocols: Array<Rpc | Stream> = [];
    const service = new Rpc(await endpoint.connect("@control", "service"));
    protocols.push(service);
    await service.request("hello", {
        clientKind: "cli",
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
    return {
        close() {
            for (const protocol of protocols) protocol.close();
            endpoint.close();
        },
        async open(host, port, name, payload) {
            const protocol = new Stream(await endpoint.connect(host, port));
            protocols.push(protocol);
            return await protocol.open(name, payload);
        },
    };
}

async function readMessage(
    stream: MessageStream,
): Promise<ControlStreamMessage> {
    const next = await stream.readMessage();
    assert.equal(next.type, "data");
    return next.message as ControlStreamMessage;
}

class FakeWorker {
    readonly #name: string;
    #events: Array<{
        at: string;
        data?: JsonValue;
        instanceName: string;
        seq: number;
        type: string;
    }> = [];
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
            status: "ready",
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
            lastSeq: this.#lastSeq,
        };
    }

    emit(type: string, data?: JsonValue) {
        const event = {
            at: new Date().toISOString(),
            ...(data === undefined ? {} : { data }),
            instanceName: this.#name,
            seq: ++this.#lastSeq,
            type,
        };
        this.#events.push(event);
    }

    dropBefore(seq: number) {
        this.#events = this.#events.filter((event) => event.seq >= seq);
    }
}

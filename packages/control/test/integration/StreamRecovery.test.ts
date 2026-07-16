import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkerInstance } from "@portable-devshell/core";
import {
    Channel,
    Codec,
    PrefixRoute,
    asInstanceName,
    type JsonValue
} from "@portable-devshell/shared";

import { RouteComposition } from "../../dist/composition/RouteComposition.js";
import { ControlSocketServer } from "../../dist/control/socket/ControlSocketServer.js";
import { InstanceRegistry } from "../../dist/modules/instance/registry/InstanceRegistry.js";

test("stream gap is non-terminal and the dedicated subscription remains usable", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-stream-recovery-"));
    const socketPath = join(directory, "control.sock");
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started", { workspacePath: "/tmp/ws" });
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "alpha",
            todo: {
                async read() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                summary() {
                    return undefined;
                }
            },
            worker: worker as unknown as WorkerInstance
        }
    ]);
    const routes = new RouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await server.stop().catch(() => undefined);
        routes.dispose();
        await rm(directory, { force: true, recursive: true });
    });

    const route = await connect(socketPath);
    t.after(() => route.close());
    const acknowledgement = await route.openStream({
        destination: asInstanceName("alpha"),
        name: "runtime.subscribe",
        payload: { fromSeq: 1 }
    }, "subscribe-1");
    assert.equal(acknowledgement.replyTo, "subscribe-1");
    assert.equal(acknowledgement.streamId, "subscribe-1");
    assert.deepEqual(acknowledgement.event.payload, {
        events: [worker.events[0]],
        lastSeq: 1
    });

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    const normal = await route.nextStreamFrame();
    assert.equal(normal.event.name, "toolCall.completed");
    assert.equal(normal.event.seq, 2);

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    worker.dropBefore(4);
    const gap = await route.nextStreamFrame();
    assert.equal(gap.event.name, "stream.gap");
    assert.deepEqual(gap.event.payload, {
        instance: "alpha",
        latestSeq: 3,
        oldestAvailableSeq: 4,
        requestedFromSeq: 3
    });

    worker.emit("toolCall.completed", { toolName: "bash_run" });
    const recovered = await route.nextStreamFrame();
    assert.equal(recovered.event.name, "toolCall.completed");
    assert.equal(recovered.event.seq, 4);
});

test("an initial unavailable sequence returns a normal stream.gap error reply", async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-stream-initial-gap-"));
    const socketPath = join(directory, "control.sock");
    const worker = new FakeWorker("alpha");
    worker.emit("instance.started", {});
    worker.emit("toolCall.completed", {});
    worker.dropBefore(2);
    const registry = new InstanceRegistry([
        {
            enabled: true,
            mcpEnabled: false,
            mcpPath: "",
            name: "alpha",
            todo: {
                async read() {
                    return { items: [], revision: 0, summary: { completed: 0, total: 0 } };
                },
                summary() {
                    return undefined;
                }
            },
            worker: worker as unknown as WorkerInstance
        }
    ]);
    const routes = new RouteComposition({ instances: registry, shutdown() {} });
    const server = new ControlSocketServer({ routes, socketPath });
    await server.start();
    t.after(async () => {
        await server.stop().catch(() => undefined);
        routes.dispose();
        await rm(directory, { force: true, recursive: true });
    });

    const route = await connect(socketPath);
    t.after(() => route.close());
    const reply = await route.openStream({
        destination: asInstanceName("alpha"),
        name: "runtime.subscribe",
        payload: { fromSeq: 1 }
    });
    assert.equal(reply.event.error?.code, "stream.gap");
    assert.equal(reply.event.error?.retryable, true);
    assert.deepEqual(reply.event.error?.details, {
        instance: "alpha",
        latestSeq: 2,
        oldestAvailableSeq: 2,
        requestedFromSeq: 1
    });
});

async function connect(socketPath: string): Promise<PrefixRoute> {
    const channel = await Channel.connect(socketPath);
    return new PrefixRoute(new Codec(channel, { local: "cli", remote: "server" }), {
        requestIdPrefix: "cli"
    });
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

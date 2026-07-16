import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    asInstanceName,
    Channel,
    Codec,
    createError,
    errorCodes,
    PrefixRoute,
    type Destination,
    type JsonValue,
    type PrefixRouteEvent,
    type PrefixRouteIncoming,
    type PrefixRouteSnapshot,
    type PrefixRouteStream
} from "@portable-devshell/shared";

class EventQueue {
    readonly #events: PrefixRouteIncoming[] = [];
    readonly #waiters: Array<(event: PrefixRouteIncoming) => void> = [];

    push(event: PrefixRouteIncoming): void {
        const waiter = this.#waiters.shift();
        if (waiter === undefined) {
            this.#events.push(event);
        } else {
            waiter(event);
        }
    }

    async next(): Promise<PrefixRouteIncoming> {
        return this.#events.shift() ?? await new Promise((resolve) => this.#waiters.push(resolve));
    }
}

interface RoutePair {
    client: PrefixRoute;
    directory: string;
    events: EventQueue;
    listener: Server;
    server: PrefixRoute;
}

async function pair(snapshot: () => PrefixRouteSnapshot): Promise<RoutePair> {
    const directory = await mkdtemp(join(tmpdir(), "portable-devshell-prefix-route-"));
    const socketPath = join(directory, "route.sock");
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
        listener.once("error", reject);
        listener.listen(socketPath, resolve);
    });
    const accepted = new Promise<Channel>((resolve) => listener.once("connection", (socket) => resolve(Channel.accept(socket))));
    const clientChannel = await Channel.connect(socketPath);
    const serverChannel = await accepted;
    const client = new PrefixRoute(new Codec(clientChannel, { local: "tui", remote: "server" }));
    const events = new EventQueue();
    client.onEvent((incoming) => events.push(incoming));
    return {
        client,
        directory,
        events,
        listener,
        server: new PrefixRoute(new Codec(serverChannel, { local: "server" }), {
            connectionId: "connection-1",
            getSnapshot: snapshot,
            eventIdPrefix: "server"
        })
    };
}

async function closePair(value: RoutePair): Promise<void> {
    value.client.close();
    value.server.close();
    await new Promise<void>((resolve) => value.listener.close(() => resolve()));
    await rm(value.directory, { force: true, recursive: true });
}

const instance = asInstanceName("aromatic-pc");

async function request(
    value: RoutePair,
    destination: Destination,
    module: string,
    operation: string,
    payload?: JsonValue,
    id = "tui-42"
): Promise<PrefixRouteIncoming> {
    await value.client.send(destination, module, {
        id,
        name: operation,
        ...(payload === undefined ? {} : { payload })
    });
    return await value.events.next();
}

test("PrefixRoute consumes destination/module and gives the handler a local operation", async (t) => {
    let observed: unknown;
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{
                name: "todo",
                operations: [{
                    name: "get",
                    handle: (request, context) => {
                        observed = {
                            connectionId: context.connectionId,
                            destination: context.destination,
                            module: context.module,
                            name: request.name,
                            payload: request.payload,
                            peer: context.peer
                        };
                        return { items: [] };
                    }
                }]
            }]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    const reply = await request(value, instance, "todo", "get", { includeDone: false });

    assert.deepEqual(observed, {
        connectionId: "connection-1",
        destination: "aromatic-pc",
        module: "todo",
        name: "get",
        payload: { includeDone: false },
        peer: "tui"
    });
    assert.equal(reply.event.replyTo, "tui-42");
    assert.equal(reply.destination, "aromatic-pc");
    assert.equal(reply.module, "todo");
    assert.equal(reply.event.name, "get");
    assert.deepEqual(reply.event.payload, { items: [] });
});

test("PrefixRoute returns normal protocol errors for missing destination, module, and operation", async (t) => {
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{ name: "todo", operations: [{ name: "get", handle: () => ({}) }] }]
        }
    ]);

    const missingDestination = await pair(() => snapshot);
    t.after(() => closePair(missingDestination));
    assert.equal(
        (await request(missingDestination, asInstanceName("missing-pc"), "todo", "get")).event.error?.code,
        errorCodes.targetInvalid
    );

    const missingModule = await pair(() => snapshot);
    t.after(() => closePair(missingModule));
    assert.equal(
        (await request(missingModule, instance, "missing", "read")).event.error?.code,
        errorCodes.envelopeInvalid
    );

    const missingOperation = await pair(() => snapshot);
    t.after(() => closePair(missingOperation));
    assert.equal(
        (await request(missingOperation, instance, "todo", "subscribe")).event.error?.code,
        errorCodes.envelopeInvalid
    );
});

test("replyTo is a direct reply channel and handler errors become error replies", async (t) => {
    let calls = 0;
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{
                name: "todo",
                operations: [{
                    name: "get",
                    handle: () => {
                        calls += 1;
                        throw createError({
                            code: errorCodes.todoInvalid,
                            message: "todo failed",
                            retryable: false
                        });
                    }
                }]
            }]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    const reply = await request(value, instance, "todo", "get");
    assert.equal(calls, 1);
    assert.equal(reply.event.error?.code, errorCodes.todoInvalid);
    assert.equal(reply.module, "todo");
    assert.equal(reply.event.name, "get");
});

test("streamId is independent from replyTo and bypasses normal routing", async (t) => {
    let sender: PrefixRouteStream | undefined;
    let resolveInput!: (event: PrefixRouteEvent) => void;
    const input = new Promise<PrefixRouteEvent>((resolve) => {
        resolveInput = resolve;
    });
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{
                name: "runtime",
                operations: [{
                    name: "start",
                    handle: async (_request, context) => {
                        sender = await context.openStream(
                            { accepted: true },
                            { onEvent: (incoming) => resolveInput(incoming) }
                        );
                        await sender.emit("output", { chunk: "ready" }, 1);
                        return undefined;
                    }
                }]
            }]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    await value.client.send(instance, "runtime", { id: "start-1", name: "start" });
    const ack = await value.events.next();
    assert.equal(ack.event.replyTo, "start-1");
    assert.notEqual(ack.event.streamId, "start-1");
    assert.deepEqual(ack.event.payload, { accepted: true });

    const output = await value.events.next();
    assert.equal(output.event.streamId, ack.event.streamId);
    assert.equal(output.module, "runtime");
    assert.equal(output.event.name, "output");
    assert.deepEqual(output.event.payload, { chunk: "ready" });

    await value.client.send(instance, "runtime", {
        id: "input-1",
        streamId: ack.event.streamId,
        name: "input",
        payload: { data: "aGVsbG8=" }
    });
    assert.equal((await input).name, "input");

    await sender!.complete({ exitCode: 0 });
    const completed = await value.events.next();
    assert.equal(completed.module, "stream");
    assert.equal(completed.event.name, "completed");
    assert.deepEqual(completed.event.payload, { exitCode: 0 });
});

test("stream.cancel closes one server stream without closing the routed connection", async (t) => {
    let streamClosed = false;
    const snapshot = PrefixRoute.snapshot([{
        destination: instance,
        modules: [{
            name: "runtime",
            operations: [{
                name: "subscribe",
                handle: async (_request, context) => {
                    await context.openStream(undefined, {
                        onClose: () => {
                            streamClosed = true;
                        }
                    });
                    return undefined;
                }
            }]
        }]
    }]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    await value.client.send(instance, "runtime", { id: "subscribe-1", name: "subscribe" });
    const acknowledgement = await value.events.next();
    const streamId = acknowledgement.event.streamId!;

    await value.client.send(instance, "stream", {
        id: "cancel-1",
        streamId,
        name: "cancel"
    });
    const cancelled = await value.events.next();

    assert.equal(streamClosed, true);
    assert.equal(cancelled.module, "stream");
    assert.equal(cancelled.event.streamId, streamId);
    assert.equal(cancelled.event.name, "cancelled");
    assert.equal(value.client.closed, false);
    assert.equal(value.server.closed, false);
});

test("PrefixRoute snapshots reject duplicate destinations, modules, and operations", () => {
    assert.throws(
        () => PrefixRoute.snapshot([
            { destination: instance, modules: [] },
            { destination: instance, modules: [] }
        ]),
        /Duplicate route destination/
    );
    assert.throws(
        () => PrefixRoute.snapshot([{
            destination: instance,
            modules: [
                { name: "todo", operations: [] },
                { name: "todo", operations: [] }
            ]
        }]),
        /Duplicate route module/
    );
    assert.throws(
        () => PrefixRoute.snapshot([{
            destination: instance,
            modules: [{
                name: "todo",
                operations: [
                    { name: "get", handle: () => undefined },
                    { name: "get", handle: () => undefined }
                ]
            }]
        }]),
        /Duplicate route operation/
    );
});

test("PrefixRoute reads the current snapshot for every routed request", async (t) => {
    let snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{ name: "todo", operations: [{ name: "get", handle: () => ({ version: 1 }) }] }]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));
    assert.deepEqual((await request(value, instance, "todo", "get", undefined, "first")).event.payload, { version: 1 });

    snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{ name: "todo", operations: [{ name: "get", handle: () => ({ version: 2 }) }] }]
        }
    ]);
    assert.deepEqual((await request(value, instance, "todo", "get", undefined, "second")).event.payload, { version: 2 });
});

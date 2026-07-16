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
    type Event,
    type PrefixRouteSnapshot,
    type PrefixRouteStream
} from "@portable-devshell/shared";

interface RoutePair {
    client: PrefixRoute;
    directory: string;
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
    return {
        client: new PrefixRoute(new Codec(clientChannel, { local: "tui", remote: "server" }), {
            requestIdPrefix: "tui"
        }),
        directory,
        listener,
        server: new PrefixRoute(new Codec(serverChannel, { local: "server" }), {
            connectionId: "connection-1",
            getSnapshot: snapshot,
            requestIdPrefix: "server"
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

function event(name: Event["name"], payload?: Event["payload"]): Event {
    return {
        destination: instance,
        name,
        ...(payload === undefined ? {} : { payload })
    };
}

test("PrefixRoute consumes destination/module and gives the handler a local operation", async (t) => {
    let observed: unknown;
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [
                {
                    name: "todo",
                    operations: [
                        {
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
                        }
                    ]
                }
            ]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    const reply = await value.client.request(event("todo.get", { includeDone: false }), "tui-42");

    assert.deepEqual(observed, {
        connectionId: "connection-1",
        destination: "aromatic-pc",
        module: "todo",
        name: "get",
        payload: { includeDone: false },
        peer: "tui"
    });
    assert.equal(reply.replyTo, "tui-42");
    assert.equal(reply.event.destination, "aromatic-pc");
    assert.equal(reply.event.name, "todo.get");
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
    const destinationReply = await missingDestination.client.request({
        destination: asInstanceName("missing-pc"),
        name: "todo.get"
    });
    assert.equal(destinationReply.event.error?.code, errorCodes.targetInvalid);

    const missingModule = await pair(() => snapshot);
    t.after(() => closePair(missingModule));
    const moduleReply = await missingModule.client.request(event("missing.read"));
    assert.equal(moduleReply.event.error?.code, errorCodes.envelopeInvalid);

    const missingOperation = await pair(() => snapshot);
    t.after(() => closePair(missingOperation));
    const operationReply = await missingOperation.client.request(event("todo.subscribe"));
    assert.equal(operationReply.event.error?.code, errorCodes.envelopeInvalid);
});

test("replyTo is a direct reply channel and handler errors become error replies", async (t) => {
    let calls = 0;
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [
                {
                    name: "todo",
                    operations: [
                        {
                            name: "get",
                            handle: () => {
                                calls += 1;
                                throw createError({
                                    code: errorCodes.todoInvalid,
                                    message: "todo failed",
                                    retryable: false
                                });
                            }
                        }
                    ]
                }
            ]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    const reply = await value.client.request(event("todo.get"));
    assert.equal(calls, 1);
    assert.equal(reply.event.error?.code, errorCodes.todoInvalid);
    assert.equal(reply.event.name, "todo.get");
});

test("streamId bypasses normal routing in both directions", async (t) => {
    let sender: PrefixRouteStream | undefined;
    let resolveInput!: (event: Event) => void;
    const input = new Promise<Event>((resolve) => {
        resolveInput = resolve;
    });
    const snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [
                {
                    name: "runtime",
                    operations: [
                        {
                            name: "start",
                            handle: async (_request, context) => {
                                sender = await context.openStream(
                                    { accepted: true },
                                    {
                                        onEvent: (incoming) => resolveInput(incoming)
                                    }
                                );
                                await sender.emit("output", { chunk: "ready" }, 1);
                                return undefined;
                            }
                        }
                    ]
                }
            ]
        }
    ]);
    const value = await pair(() => snapshot);
    t.after(() => closePair(value));

    const ack = await value.client.openStream(event("runtime.start"), "start-1");
    assert.equal(ack.replyTo, "start-1");
    assert.equal(ack.streamId, "start-1");
    assert.deepEqual(ack.event.payload, { accepted: true });

    const output = await value.client.nextStreamFrame();
    assert.equal(output.streamId, "start-1");
    assert.equal(output.event.name, "runtime.output");
    assert.deepEqual(output.event.payload, { chunk: "ready" });

    await value.client.sendStream(event("runtime.input", { data: "aGVsbG8=" }));
    assert.equal((await input).name, "runtime.input");

    await sender!.complete({ exitCode: 0 });
    const completed = await value.client.nextStreamFrame();
    assert.equal(completed.event.name, "stream.completed");
    assert.deepEqual(completed.event.payload, { exitCode: 0 });
    await assert.rejects(value.client.sendStream(event("runtime.eof")), /No client stream/);
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
        () => PrefixRoute.snapshot([
            {
                destination: instance,
                modules: [
                    { name: "todo", operations: [] },
                    { name: "todo", operations: [] }
                ]
            }
        ]),
        /Duplicate route module/
    );
    assert.throws(
        () => PrefixRoute.snapshot([
            {
                destination: instance,
                modules: [
                    {
                        name: "todo",
                        operations: [
                            { name: "get", handle: () => undefined },
                            { name: "get", handle: () => undefined }
                        ]
                    }
                ]
            }
        ]),
        /Duplicate route operation/
    );
});

test("PrefixRoute reads the current immutable snapshot when a connection is attached", async (t) => {
    let snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{ name: "todo", operations: [{ name: "get", handle: () => ({ version: 1 }) }] }]
        }
    ]);
    const first = await pair(() => snapshot);
    t.after(() => closePair(first));
    assert.deepEqual((await first.client.request(event("todo.get"))).event.payload, { version: 1 });

    snapshot = PrefixRoute.snapshot([
        {
            destination: instance,
            modules: [{ name: "todo", operations: [{ name: "get", handle: () => ({ version: 2 }) }] }]
        }
    ]);
    const second = await pair(() => snapshot);
    t.after(() => closePair(second));
    assert.deepEqual((await second.client.request(event("todo.get"))).event.payload, { version: 2 });
});

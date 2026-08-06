import assert from "node:assert/strict";
import test from "node:test";

import {
    ClientStream,
    createControlClients,
    type ClientConnection,
    type OpenedClientStream,
} from "@portable-devshell/shared";

class RecordingConnection {
    readonly requests: Array<{
        destination: string;
        module: string;
        operation: string;
        payload?: unknown;
    }> = [];
    readonly streams: Array<{
        destination: string;
        module: string;
        operation: string;
        payload?: unknown;
    }> = [];

    async request<TResult>(
        destination: string,
        module: string,
        operation: string,
        payload?: unknown,
    ): Promise<TResult> {
        this.requests.push({ destination, module, operation, payload });
        if (operation === "hello") {
            return {
                capabilities: ["request", "stream", "streamResume"],
                protocolVersion: 1,
            } as TResult;
        }
        return [] as TResult;
    }

    async openStream(
        destination: string,
        module: string,
        operation: string,
        payload?: unknown,
    ): Promise<OpenedClientStream> {
        this.streams.push({ destination, module, operation, payload });
        return {
            acknowledgement: {
                destination: destination as never,
                id: `ack-${operation}`,
                name: `${module}.${operation}`,
                payload: { events: [] },
                streamId: `stream-${operation}`,
            },
            stream: new ClientStream(`stream-${operation}`, {
                close() {},
                async nextEvent() {
                    throw new Error("Not used.");
                },
                async send() {},
            }),
        };
    }

    mapError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    throwRemoteError(): void {}
}

test("typed Control clients route shared operations through one canonical surface", async () => {
    const connection = new RecordingConnection();
    const clients = createControlClients(
        connection as unknown as ClientConnection,
        { clientKind: "tui" },
    );

    await clients.service.hello();
    await clients.instance.list();
    await clients.runtime.readLogs("alpha", { limit: 20 });
    const start = await clients.runtime.openStart("alpha", "/workspace");
    const todo = await clients.todo.subscribe("alpha", 5);
    start.stream.close();
    todo.close();
    await clients.contextMessage.list("alpha", "ctx-1");
    await clients.terminal.list("alpha");
    await clients.tool.listApprovals("alpha");

    assert.deepEqual(connection.streams, [
        {
            destination: "alpha",
            module: "runtime",
            operation: "start",
            payload: { workspacePath: "/workspace" },
        },
        {
            destination: "alpha",
            module: "todo",
            operation: "subscribe",
            payload: { fromSeq: 5 },
        },
    ]);

    assert.deepEqual(connection.requests, [
        {
            destination: "@control",
            module: "service",
            operation: "hello",
            payload: {
                clientKind: "tui",
                maxProtocolVersion: 1,
                minProtocolVersion: 1,
            },
        },
        {
            destination: "@control",
            module: "instance",
            operation: "list",
            payload: undefined,
        },
        {
            destination: "alpha",
            module: "runtime",
            operation: "readLogs",
            payload: { limit: 20 },
        },
        {
            destination: "alpha",
            module: "contextMessage",
            operation: "list",
            payload: { ctxId: "ctx-1" },
        },
        {
            destination: "alpha",
            module: "terminal",
            operation: "list",
            payload: undefined,
        },
        {
            destination: "alpha",
            module: "tool",
            operation: "listApprovals",
            payload: undefined,
        },
    ]);
});

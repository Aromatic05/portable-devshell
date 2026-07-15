import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const {
    ProtocolControlClientConnection,
    ProtocolControlStream,
    controlMethods,
    createInstanceTarget
} = await import("@portable-devshell/shared");

test("control method catalog is complete and duplicate-free", () => {
    const methods = Object.values(controlMethods);
    assert.equal(methods.length, 43);
    assert.equal(new Set(methods).size, methods.length);
    assert.equal(controlMethods.controlDecideOAuthApproval, "control.decideOAuthApproval");
    assert.equal(controlMethods.controlGetMcpStatus, "control.getMcpStatus");
    assert.equal(controlMethods.controlListOAuthApprovals, "control.listOAuthApprovals");
});

test("ProtocolControlStream drains initial events before live messages", async () => {
    const event = {
        event: "instance.started",
        payload: { instanceName: "demo", seq: 1, type: "instance.started", at: "now" },
        seq: 1,
        target: createInstanceTarget("demo"),
        type: "event"
    };
    let closed = false;
    const stream = new ProtocolControlStream({
        close: () => { closed = true; },
        nextStreamMessage: async () => ({ kind: "connection.closed" })
    }, [event]);

    assert.deepEqual(await stream.nextMessage(), { envelope: event, kind: "instance.event" });
    assert.deepEqual(await stream.nextMessage(), { kind: "connection.closed" });
    stream.close();
    assert.equal(closed, true);
    assert.equal((await stream.nextMessage()).kind, "stream.cancelled");
});

test("ProtocolControlClientConnection identifies the request interrupted by a clean socket close", async (t) => {
    const runtimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-client-"));
    const socketPath = join(runtimeDir, "control.sock");
    const server = createServer((socket) => {
        socket.once("data", () => {
            socket.end();
        });
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
    });

    t.after(async () => {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
        await rm(runtimeDir, { force: true, recursive: true });
    });

    const connection = new ProtocolControlClientConnection({
        clientKind: "tui",
        connectionClosedMessage: "closed",
        mapConnectionError: (error) => (error instanceof Error ? error : new Error(String(error))),
        mapRemoteError: () => new Error("remote error"),
        mapStreamMessage: () => "event",
        requestIdPrefix: "test",
        socketPath
    });

    await assert.rejects(
        connection.request("control.ping", { kind: "control" }),
        /control connection closed while waiting for control\.identifyClient/u
    );
});

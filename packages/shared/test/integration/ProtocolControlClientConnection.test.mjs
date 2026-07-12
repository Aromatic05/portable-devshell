import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const { ProtocolControlClientConnection } = await import("@portable-devshell/shared");

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
        createRuntimeDirError: (message) => new Error(message),
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

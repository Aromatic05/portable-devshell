import assert from "node:assert/strict";
import test from "node:test";

import { WorkerInstanceArtifact } from "../../../src/worker/instance/capability/Artifact.ts";
import { WorkerInstanceAudit } from "../../../src/worker/instance/capability/Audit.ts";

test("worker artifact facade checks readiness and delegates control lifecycle operations", async () => {
    const calls: Array<[string, unknown]> = [];
    let readyChecks = 0;
    const protocolClient = {
        async abortArtifactReceive(receiveId: string) {
            calls.push(["abort", receiveId]);
        },
        async beginArtifactReceive(input: unknown) {
            calls.push(["begin", input]);
            return { nextOffsetBytes: 0, receiveId: "receive-1" };
        },
        async closeArtifactPayload(payloadId: string) {
            calls.push(["close", payloadId]);
        },
        async finishArtifactReceive(receiveId: string) {
            calls.push(["finish", receiveId]);
            return {
                blake3: "a".repeat(64),
                bytes: 4,
                receiveId,
                targetPath: "/tmp/result.bin",
            };
        },
        async openArtifactPayload(input: unknown) {
            calls.push(["open", input]);
            return {
                descriptor: {
                    mediaType: "application/octet-stream",
                    name: "result.bin",
                    payloadBlake3: "a".repeat(64),
                    payloadBytes: 4,
                    type: "file",
                },
                expiresAtMs: 100,
                payloadId: "payload-1",
            };
        },
    };
    const artifact = new WorkerInstanceArtifact({
        assertReady() {
            readyChecks += 1;
        },
        protocolClient: protocolClient as never,
        serviceClient: {} as never,
    });

    const openInput = {
        expiresAtMs: 100,
        path: "./result.bin",
        workspace: "/workspace",
    } as const;
    const beginInput = {
        descriptor: {
            mediaType: "application/octet-stream",
            name: "result.bin",
            payloadBlake3: "a".repeat(64),
            payloadBytes: 4,
            type: "file" as const,
        },
        overwrite: false,
        targetPath: "/tmp/result.bin",
        workspace: "/tmp",
    };
    assert.equal(
        (await artifact.openPayload(openInput)).payloadId,
        "payload-1",
    );
    await artifact.closePayload("payload-1");
    assert.equal(
        (await artifact.beginReceive(beginInput)).receiveId,
        "receive-1",
    );
    assert.equal((await artifact.finishReceive("receive-1")).bytes, 4);
    await artifact.abortReceive("receive-2");

    assert.equal(readyChecks, 5);
    assert.deepEqual(calls, [
        ["open", openInput],
        ["close", "payload-1"],
        ["begin", beginInput],
        ["finish", "receive-1"],
        ["abort", "receive-2"],
    ]);
});

test("worker artifact facade delegates chunk reads and writes to the service client", async () => {
    const calls: Array<[string, unknown]> = [];
    const artifact = new WorkerInstanceArtifact({
        assertReady() {},
        protocolClient: {} as never,
        serviceClient: {
            async readArtifactPayload(input: unknown) {
                calls.push(["read", input]);
                return {
                    bytes: new Uint8Array([0x65, 0x73, 0x74]),
                    eof: true,
                    offsetBytes: 1,
                    payloadId: "payload-1",
                    returnedBytes: 3,
                    totalBytes: 4,
                };
            },
            async writeArtifactReceive(input: unknown) {
                calls.push(["write", input]);
                return {
                    nextOffsetBytes: 8,
                    receivedBytes: 8,
                    receiveId: "receive-1",
                };
            },
        } as never,
    });

    const readInput = {
        maxBytes: 3,
        offsetBytes: 1,
        payloadId: "payload-1",
    };
    const writeInput = {
        bytes: new Uint8Array([0x74, 0x65, 0x73, 0x74]),
        offsetBytes: 4,
        receiveId: "receive-1",
    };
    assert.deepEqual(
        (await artifact.readPayload(readInput)).bytes,
        new Uint8Array([0x65, 0x73, 0x74]),
    );
    assert.equal((await artifact.writeReceive(writeInput)).nextOffsetBytes, 8);
    assert.deepEqual(calls, [
        ["read", readInput],
        ["write", writeInput],
    ]);
});

test("worker artifact facade never calls the protocol client when readiness fails", async () => {
    let protocolCalls = 0;
    const expected = new Error("instance not ready");
    const artifact = new WorkerInstanceArtifact({
        assertReady() {
            throw expected;
        },
        protocolClient: {
            async openArtifactPayload() {
                protocolCalls += 1;
                return {};
            },
        } as never,
        serviceClient: {} as never,
    });

    await assert.rejects(
        artifact.openPayload({
            expiresAtMs: 100,
            path: "./result.bin",
            workspace: "/workspace",
        }),
        (error: unknown) => error === expected,
    );
    assert.equal(protocolCalls, 0);
});

test("worker audit emits MCP lifecycle records without undefined fields", async () => {
    const events: Array<{ data?: unknown; type: string }> = [];
    const audit = new WorkerInstanceAudit({
        appendEvent: async (type, data) => {
            events.push({ data, type });
        },
        auditDatabase: { close() {} } as never,
        isReady: () => false,
        protocolClient: {} as never,
    });

    await audit.appendMcpSessionOpened("session-1");
    await audit.appendMcpToolCalled("bash_run", { ctxId: "ctx-1" });
    await audit.appendMcpToolCalled("file_read", { requestId: "request-1" });
    await audit.appendMcpSessionClosed("session-1");

    assert.deepEqual(events, [
        { data: { sessionId: "session-1" }, type: "mcp.sessionOpened" },
        {
            data: { ctxId: "ctx-1", source: "mcp", toolName: "bash_run" },
            type: "mcp.toolCalled",
        },
        {
            data: {
                requestId: "request-1",
                source: "mcp",
                toolName: "file_read",
            },
            type: "mcp.toolCalled",
        },
        { data: { sessionId: "session-1" }, type: "mcp.sessionClosed" },
    ]);
});

test("worker audit releases ready sessions best-effort and closes its database", async () => {
    const calls: string[] = [];
    let ready = false;
    const audit = new WorkerInstanceAudit({
        appendEvent: async () => undefined,
        auditDatabase: {
            close() {
                calls.push("database.close");
            },
        } as never,
        isReady: () => ready,
        protocolClient: {
            async closeToolSession(sessionId: string) {
                calls.push(`session.close:${sessionId}`);
                throw new Error("transport already closed");
            },
        } as never,
    });

    await audit.releaseToolSession("offline-session");
    ready = true;
    await audit.releaseToolSession("online-session");
    audit.close();

    assert.deepEqual(calls, ["session.close:online-session", "database.close"]);
});

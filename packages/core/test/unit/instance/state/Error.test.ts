import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import { InstanceEventBuffer } from "../../../../src/instance/runtime/supervision/Event.ts";
import { InstanceStateMachine } from "../../../../src/instance/runtime/supervision/State.ts";
import { WorkerInstance } from "../../../../src/instance/runtime/index.ts";
import { WorkerProtocolClient } from "../../../../src/instance/transport/packet/Client.ts";
import { resolveWorkerInstanceConfig } from "../../../../src/instance/runtime/provision/Config.ts";
import { TransportConnection } from "../../../../src/instance/transport/endpoint/Connection.ts";
import {
    Endpoint,
    Rpc,
    StreamChannel,
    WORKER_PROTOCOL_VERSION,
    asInstanceName,
    createRemoteError,
    type Channel,
} from "@portable-devshell/shared";

test("WorkerInstance wraps start stop and status command failures with diagnostic details", async () => {
    const startFailure = createInstance({
        start: async () => ({
            details: {
                commandDisplay:
                    "ssh devbox -- devshell-worker start --instance demo-local",
                exitCode: 255,
                instance: "demo-local",
                operation: "start",
                provider: "ssh",
                stderrTail: "Permission denied\n",
            },
            exitCode: 255,
            stderr: "Permission denied\n",
            stdout: "",
        }),
    });

    await assert.rejects(startFailure.supervision.lifecycle.start(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal(
            (error as { code?: string }).code,
            "core.workerStartFailed",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.provider,
            "ssh",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.operation,
            "start",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.exitCode,
            255,
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details
                ?.stderrTail,
            "Permission denied\n",
        );
        return true;
    });

    const stopFailure = createInstance({
        stop: async () => ({
            details: {
                commandDisplay:
                    "docker exec worker-container devshell-worker stop --instance demo-local",
                exitCode: 125,
                instance: "demo-local",
                operation: "stop",
                provider: "docker",
                stderrTail: "container exited\n",
            },
            exitCode: 125,
            stderr: "container exited\n",
            stdout: "",
        }),
    });

    await assert.rejects(stopFailure.supervision.lifecycle.stop(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal(
            (error as { code?: string }).code,
            "core.workerStopFailed",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.provider,
            "docker",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.operation,
            "stop",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.exitCode,
            125,
        );
        return true;
    });

    const statusFailure = createInstance({
        status: async () => ({
            details: {
                commandDisplay:
                    "podman exec worker-container devshell-worker status --instance demo-local",
                exitCode: 126,
                instance: "demo-local",
                operation: "status",
                provider: "podman",
                stderrTail: "status unavailable\n",
            },
            exitCode: 126,
            stderr: "status unavailable\n",
            stdout: "",
        }),
    });

    await assert.rejects(statusFailure.supervision.recovery.refreshStatus(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal(
            (error as { code?: string }).code,
            "core.workerStatusFailed",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.provider,
            "podman",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.operation,
            "status",
        );
        assert.equal(
            (error as { details?: Record<string, unknown> }).details?.exitCode,
            126,
        );
        return true;
    });
});

test("WorkerProtocolClient preserves tool-list failures", async () => {
    const pair = channelPair();
    const client = new Endpoint({
        host: "control",
        connectChannel: async () => pair.client,
    });
    const server = new Endpoint({ host: "worker" });
    const accepting = server.accept(pair.server);
    const tool = new Rpc(server.bind("tool"), {
        "tools.list": () => {
            throw createRemoteError({
                code: "core.toolSchemaUnavailable",
                details: { toolName: "bash_run" },
                message: "catalog-error-fixture",
                retryable: false,
            });
        },
    });
    await client.connect("worker", "tool");
    await accepting;

    try {
        const worker = new WorkerProtocolClient(client, "worker");
        await assert.rejects(worker.listTools(), (error: unknown) => {
            assert.ok(typeof error === "object" && error !== null);
            assert.equal(
                (error as { code?: string }).code,
                "core.toolSchemaUnavailable",
            );
            assert.equal(
                (error as { message?: string }).message,
                "catalog-error-fixture",
            );
            return true;
        });
    } finally {
        tool.close();
        client.close();
        server.close();
    }
});

function channelPair(): { client: Channel; server: Channel } {
    const leftToRight = new PassThrough();
    const rightToLeft = new PassThrough();
    let closed = false;
    let left: StreamChannel;
    let right: StreamChannel;
    const close = (error?: Error) => {
        if (closed) return;
        closed = true;
        left.close(error);
        right.close(error);
    };
    left = new StreamChannel(rightToLeft, leftToRight, {
        closeTransport: close,
    });
    right = new StreamChannel(leftToRight, rightToLeft, {
        closeTransport: close,
    });
    return { client: left, server: right };
}

function createInstance(
    commands: Partial<{
        start: () => Promise<{
            details?: Record<string, unknown>;
            exitCode: number | null;
            stderr: string;
            stdout: string;
        }>;
        status: () => Promise<{
            details?: Record<string, unknown>;
            exitCode: number | null;
            stderr: string;
            stdout: string;
        }>;
        stop: () => Promise<{
            details?: Record<string, unknown>;
            exitCode: number | null;
            stderr: string;
            stdout: string;
        }>;
    }>,
): WorkerInstance {
    const instanceName = asInstanceName("demo-local");
    const endpoint = new Endpoint();
    const transportConnection = new TransportConnection(async () => {
        throw new Error("not used by command failure tests");
    });
    return new WorkerInstance({
        admission: { active: () => true, enabled: () => true },
        commandClient: {
            start:
                commands.start ??
                (async () => ({ exitCode: 0, stderr: "", stdout: "{}" })),
            status:
                commands.status ??
                (async () => ({
                    exitCode: 0,
                    stderr: "",
                    stdout: '{"state":"stopped"}',
                })),
            stop:
                commands.stop ??
                (async () => ({ exitCode: 0, stderr: "", stdout: "{}" })),
        } as never,
        config: resolveWorkerInstanceConfig({
            name: instanceName,
            runtime: {} as never,
            transportConnection,
        }),
        events: new InstanceEventBuffer(instanceName, 8),
        protocolClient: {
            handshake: async () => ({
                capabilities: { cancel: true, streaming: true, tools: true },
                homeDirectory: "/tmp",
                instance: "demo-local",
                platform: { arch: "x64", os: "linux" },
                protocolVersion: WORKER_PROTOCOL_VERSION,
                workerVersion: "0.0.0",
            }),
            ping: async () => ({ pong: true }),
        } as never,
        endpoint,
        onReadyChanged: async () => {},
        stateMachine: new InstanceStateMachine(instanceName),
        transportConnection,
    });
}

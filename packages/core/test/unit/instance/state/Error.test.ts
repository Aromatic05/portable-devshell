import assert from "node:assert/strict";
import test from "node:test";

import { InstanceEventBuffer } from "../../../../src/instance/runtime/supervision/Event.ts";
import { InstanceStateMachine } from "../../../../src/instance/runtime/supervision/State.ts";
import { WorkerInstance } from "../../../../src/instance/runtime/index.ts";
import { WORKER_PROTOCOL_VERSION } from "../../../../src/instance/transport/packet/Client.ts";
import { resolveWorkerInstanceConfig } from "../../../../src/instance/runtime/provision/Config.ts";
import { TransportConnection } from "../../../../src/instance/transport/endpoint/Connection.ts";
import {
    Endpoint,
    asInstanceName,
    createRemoteError,
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

    await assert.rejects(startFailure.start(), (error: unknown) => {
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

    await assert.rejects(stopFailure.stop(), (error: unknown) => {
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

    await assert.rejects(statusFailure.refreshStatus(), (error: unknown) => {
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

test("WorkerInstance preserves protocol tool-list failures", async () => {
    const instance = createInstance({
        listTools: async () => {
            throw createRemoteError({
                code: "core.toolSchemaUnavailable",
                details: { toolName: "bash_run" },
                message: "catalog-error-fixture",
                retryable: false,
            });
        },
    });

    await assert.rejects(instance.readWorkerTools(), (error: unknown) => {
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
});

function createInstance(
    commands: Partial<{
        listTools: () => Promise<{ tools: [] }>;
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
            listTools: commands.listTools ?? (async () => ({ tools: [] })),
            ping: async () => ({ pong: true }),
        } as never,
        endpoint,
        stateMachine: new InstanceStateMachine(instanceName),
        transportConnection,
    });
}

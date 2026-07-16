import assert from "node:assert/strict";
import test from "node:test";

import { WorkerInstance, InstanceStateMachine } from "@portable-devshell/core/testing";
import { asInstanceName, createError } from "@portable-devshell/shared";

test("WorkerInstance wraps start stop and status command failures with diagnostic details", async () => {
    const startFailure = createInstance({
        start: async () => ({
            details: {
                commandDisplay: "ssh devbox -- devshell-worker start --instance demo-local",
                exitCode: 255,
                instance: "demo-local",
                operation: "start",
                provider: "ssh",
                stderrTail: "Permission denied\n"
            },
            exitCode: 255,
            stderr: "Permission denied\n",
            stdout: ""
        })
    });

    await assert.rejects(startFailure.start("/tmp/workspace"), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerStartFailed");
        assert.equal((error as { details?: Record<string, unknown> }).details?.provider, "ssh");
        assert.equal((error as { details?: Record<string, unknown> }).details?.operation, "start");
        assert.equal((error as { details?: Record<string, unknown> }).details?.exitCode, 255);
        assert.equal((error as { details?: Record<string, unknown> }).details?.stderrTail, "Permission denied\n");
        return true;
    });

    const stopFailure = createInstance({
        stop: async () => ({
            details: {
                commandDisplay: "docker exec worker-container devshell-worker stop --instance demo-local",
                exitCode: 125,
                instance: "demo-local",
                operation: "stop",
                provider: "docker",
                stderrTail: "container exited\n"
            },
            exitCode: 125,
            stderr: "container exited\n",
            stdout: ""
        })
    });

    await assert.rejects(stopFailure.stop(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerStopFailed");
        assert.equal((error as { details?: Record<string, unknown> }).details?.provider, "docker");
        assert.equal((error as { details?: Record<string, unknown> }).details?.operation, "stop");
        assert.equal((error as { details?: Record<string, unknown> }).details?.exitCode, 125);
        return true;
    });

    const statusFailure = createInstance({
        status: async () => ({
            details: {
                commandDisplay: "podman exec worker-container devshell-worker status --instance demo-local",
                exitCode: 126,
                instance: "demo-local",
                operation: "status",
                provider: "podman",
                stderrTail: "status unavailable\n"
            },
            exitCode: 126,
            stderr: "status unavailable\n",
            stdout: ""
        })
    });

    await assert.rejects(statusFailure.refreshStatus(), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerStatusFailed");
        assert.equal((error as { details?: Record<string, unknown> }).details?.provider, "podman");
        assert.equal((error as { details?: Record<string, unknown> }).details?.operation, "status");
        assert.equal((error as { details?: Record<string, unknown> }).details?.exitCode, 126);
        return true;
    });
});

test("WorkerInstance preserves catalog failures during startup", async () => {
    const instance = createInstance({
        listTools: async () => {
            throw createError({
                code: "core.toolSchemaUnavailable",
                details: { toolName: "bash_run" },
                message: "Worker tool catalog is incompatible.",
                retryable: false
            });
        }
    });

    await assert.rejects(instance.start("/tmp/workspace"), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.toolSchemaUnavailable");
        assert.equal((error as { message?: string }).message, "Worker tool catalog is incompatible.");
        return true;
    });
});

function createInstance(
    commands: Partial<{
        listTools: () => Promise<{ tools: [] }>;
        start: () => Promise<{ details?: Record<string, unknown>; exitCode: number | null; stderr: string; stdout: string }>;
        status: () => Promise<{ details?: Record<string, unknown>; exitCode: number | null; stderr: string; stdout: string }>;
        stop: () => Promise<{ details?: Record<string, unknown>; exitCode: number | null; stderr: string; stdout: string }>;
    }>
): WorkerInstance {
    return new WorkerInstance({
        approvalManager: {
            decideApproval: async () => {
                throw createError({
                    code: "core.approvalNotFound",
                    message: "unused",
                    retryable: false
                });
            },
            evaluate: async () => ({ decision: "allow" }),
            getApproval: async () => {
                throw createError({
                    code: "core.approvalNotFound",
                    message: "unused",
                    retryable: false
                });
            },
            listApprovals: async () => []
        } as never,
        auditDatabase: {
            close: () => undefined
        } as never,
        catalog: {
            hasSchema: () => false,
            listTools: () => [],
            refresh: () => []
        } as never,
        commandClient: {
            start: commands.start ?? (async () => ({ exitCode: 0, stderr: "", stdout: "{}" })),
            status: commands.status ?? (async () => ({ exitCode: 0, stderr: "", stdout: '{"state":"stopped"}' })),
            stop: commands.stop ?? (async () => ({ exitCode: 0, stderr: "", stdout: "{}" }))
        } as never,
        config: {
            handshake: {
                clientName: "portable-devshell",
                clientVersion: "0.1.0",
                maxProtocolVersion: 2,
                minProtocolVersion: 2
            },
            name: asInstanceName("demo-local")
        } as never,
        eventBuffer: {
            append: async () => ({ seq: 1 })
        } as never,
        logStore: {
            append: async () => undefined,
            read: async () => []
        } as never,
        protocolClient: {
            handshake: async () => ({ instance: "demo-local", protocolVersion: 2, workspace: "/tmp/workspace", workerVersion: "0.0.0" }),
            listTools: commands.listTools ?? (async () => ({ tools: [] })),
            ping: async () => ({ pong: true })
        } as never,
        rpcBridge: {
            close: () => undefined,
            connect: async () => undefined,
            onDisconnect: () => () => undefined
        } as never,
        stateMachine: new InstanceStateMachine(asInstanceName("demo-local")),
        toolCallHistory: {
            read: async () => []
        } as never,
        toolInvoker: {
            invoke: async () => {
                throw createError({
                    code: "core.providerFailed",
                    message: "unused",
                    retryable: false
                });
            }
        } as never
    });
}

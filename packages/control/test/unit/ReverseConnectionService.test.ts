import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { WorkerRpcChannel } from "@portable-devshell/core/testing";
import type { JsonValue } from "@portable-devshell/shared";

import { ReverseConnectionService } from "../../src/control/reverse/connection/ReverseConnectionService.ts";
import { ReverseCredentialStore } from "../../src/control/reverse/credential/ReverseCredentialStore.ts";

class MemoryRpcChannel implements WorkerRpcChannel {
    readonly sent: JsonValue[] = [];
    readonly disconnectListeners = new Set<(error: unknown) => void>();
    readonly messageListeners = new Set<(message: JsonValue) => void>();
    closed = false;

    close(): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of this.disconnectListeners) {
            listener(new Error("closed"));
        }
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        this.disconnectListeners.add(listener);
        return () => this.disconnectListeners.delete(listener);
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        this.messageListeners.add(listener);
        return () => this.messageListeners.delete(listener);
    }

    async send(message: JsonValue): Promise<void> {
        this.sent.push(message);
    }

    emit(message: JsonValue): void {
        for (const listener of this.messageListeners) {
            listener(message);
        }
    }
}

test("ReverseConnectionService enrolls and authenticates without an HTTP server", async () => {
    const home = await mkdtemp(join(tmpdir(), "reverse-connection-service-"));
    const credentialStore = new ReverseCredentialStore(home);
    const enrollmentStates: string[] = [];
    const descriptor = {
        name: "remote-test",
        provider: "reverse" as const,
        reverseConnector: {} as never,
        worker: {
            acceptReverseChannel: async () => undefined,
            setReverseEnrollmentState: async (state: string) => {
                enrollmentStates.push(state);
            },
            snapshot: () => ({}) as never
        },
        workspace: "/workspace"
    };
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: {
            get: (instanceName) => instanceName === descriptor.name ? descriptor : undefined
        },
        publicBaseUrl: "https://example.test/devshell"
    });
    const code = await credentialStore.createDeviceCode(descriptor.name);
    const enrolled = await service.enroll({
        arch: "x86_64",
        deviceCode: code.deviceCode,
        os: "linux",
        workerVersion: "0.4.4"
    }) as Record<string, JsonValue>;

    assert.equal(enrolled.controllerUrl, "https://example.test/devshell");
    assert.equal(enrolled.instance, descriptor.name);
    assert.equal(enrolled.workspace, "/workspace");
    assert.deepEqual(enrollmentStates, ["enrolled"]);
    assert.equal(typeof enrolled.deviceToken, "string");

    const identity = await service.authenticate(
        descriptor.name,
        1,
        enrolled.deviceToken as string
    );
    assert.equal(identity.descriptor, descriptor);
    assert.equal(identity.generation, 1);

    await assert.rejects(
        service.authenticate(descriptor.name, 1, "invalid-token"),
        (error: unknown) => hasCode(error, "reverse.deviceTokenInvalid")
    );
});

test("ReverseConnectionService owns generation replacement and disconnect state", async () => {
    const home = await mkdtemp(join(tmpdir(), "reverse-generation-service-"));
    const credentialStore = new ReverseCredentialStore(home);
    let generation = 0;
    const accepted: Array<{ channel: WorkerRpcChannel; generation: number; transport: string }> = [];
    const descriptor = {
        name: "remote-test",
        provider: "reverse" as const,
        reverseConnector: {} as never,
        worker: {
            acceptReverseChannel: async (
                channel: WorkerRpcChannel,
                options: { generation: number; transport: "sse" | "wss" }
            ) => {
                generation = options.generation;
                accepted.push({ channel, ...options });
            },
            setReverseEnrollmentState: async () => undefined,
            snapshot: () => ({
                reverse: generation === 0 ? undefined : { generation }
            }) as never
        }
    };
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: {
            get: (instanceName) => instanceName === descriptor.name ? descriptor : undefined
        },
        publicBaseUrl: "https://example.test"
    });
    const code = await credentialStore.createDeviceCode(descriptor.name);
    const enrollment = await service.enroll({
        arch: "aarch64",
        deviceCode: code.deviceCode,
        os: "darwin",
        workerVersion: "0.4.4"
    }) as Record<string, JsonValue>;
    const identityOne = await service.authenticate(
        descriptor.name,
        1,
        enrollment.deviceToken as string
    );
    const first = new MemoryRpcChannel();
    await service.activate(identityOne, "wss", first);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0]?.generation, 1);

    const duplicate = new MemoryRpcChannel();
    await assert.rejects(
        service.activate(identityOne, "wss", duplicate),
        (error: unknown) => hasCode(error, "reverse.generationInvalid")
    );
    assert.equal(duplicate.closed, true);

    const identityTwo = await service.authenticate(
        descriptor.name,
        2,
        enrollment.deviceToken as string
    );
    const second = new MemoryRpcChannel();
    await service.activate(identityTwo, "wss", second);
    assert.equal(accepted.length, 2);
    assert.equal(accepted[1]?.generation, 2);

    service.disconnect(descriptor.name);
    assert.equal(second.closed, true);
    service.stop();
});

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code;
}

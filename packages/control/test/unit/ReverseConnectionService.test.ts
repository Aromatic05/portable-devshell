import assert from "node:assert/strict";

import { join } from "node:path";
import test from "node:test";

import { asInstanceName, type Channel, type InstanceSnapshot, type JsonValue } from "@portable-devshell/shared";

import { ReverseConnectionService } from "../../src/control/reverse/connection/ReverseConnectionService.ts";
import { ReverseCredentialService } from "../../src/control/reverse/credential/ReverseCredentialService.ts";
import { ReverseCredentialStore } from "../../src/control/reverse/credential/ReverseCredentialStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

class MemoryRpcChannel implements Channel {
    readonly sent: Uint8Array[] = [];
    readonly closeListeners = new Set<(error?: Error) => void>();
    readonly frameListeners = new Set<(frame: Uint8Array) => void>();
    closed = false;

    close(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of [...this.closeListeners]) listener(error ?? new Error("closed"));
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        this.frameListeners.add(listener);
        return () => this.frameListeners.delete(listener);
    }

    async send(frame: Uint8Array): Promise<void> {
        this.sent.push(Uint8Array.from(frame));
    }
}

test("ReverseConnectionService enrolls and authenticates without an HTTP server", async () => {
    const home = await createTestTempDirectory("reverse-connection-service");
    const credentialStore = new ReverseCredentialStore(home);
    const enrollmentStates: string[] = [];
    const descriptor = {
        name: asInstanceName("remote-test"),
        provider: "reverse" as const,
        reverseConnector: {} as never,
        worker: {
            acceptReverseChannel: async (): Promise<InstanceSnapshot> => ({
                connectionState: "connected",
                daemonState: "running",
                lastSeq: 0,
                name: asInstanceName("remote-test"),
                ready: true,
                status: "ready"
            }),
            setReverseEnrollmentState: async (state: string): Promise<InstanceSnapshot> => {
                enrollmentStates.push(state);
                return reverseSnapshot();
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
    const home = await createTestTempDirectory("reverse-generation-service");
    const credentialStore = new ReverseCredentialStore(home);
    let generation = 0;
    const accepted: Array<{ channel: Channel; generation: number; transport: string }> = [];
    const descriptor = {
        name: asInstanceName("remote-test"),
        provider: "reverse" as const,
        reverseConnector: {} as never,
        worker: {
            acceptReverseChannel: async (
                channel: Channel,
                options: { generation: number; transport: "sse" | "wss" }
            ): Promise<InstanceSnapshot> => {
                generation = options.generation;
                accepted.push({ channel, ...options });
                return {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 0,
                    name: asInstanceName("remote-test"),
                    ready: true,
                    status: "ready"
                };
            },
            setReverseEnrollmentState: async (): Promise<InstanceSnapshot> => reverseSnapshot(),
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

test("ReverseConnectionService rejects activation after an authenticated token is revoked", async () => {
    const home = await createTestTempDirectory("reverse-revoked-activation");
    const credentialStore = new ReverseCredentialStore(home);
    let accepted = 0;
    const descriptor = reverseDescriptor(async () => {
        accepted += 1;
        return reverseSnapshot();
    });
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: { get: (name) => name === descriptor.name ? descriptor : undefined },
        publicBaseUrl: "https://example.test"
    });
    const code = await credentialStore.createDeviceCode(descriptor.name);
    const enrollment = await service.enroll({
        arch: "x86_64",
        deviceCode: code.deviceCode,
        os: "linux",
        workerVersion: "test"
    }) as Record<string, JsonValue>;
    const identity = await service.authenticate(
        descriptor.name,
        1,
        enrollment.deviceToken as string
    );
    await credentialStore.revoke(descriptor.name);
    const channel = new MemoryRpcChannel();

    await assert.rejects(
        service.activate(identity, "wss", channel),
        (error: unknown) => hasCode(error, "reverse.deviceTokenInvalid")
    );

    assert.equal(channel.closed, true);
    assert.equal(accepted, 0);
});

test("ReverseConnectionService lets token rotation disconnect a pending activation", async () => {
    const home = await createTestTempDirectory("reverse-activation-rotation");
    const credentialStore = new ReverseCredentialStore(home);
    let releaseActivation!: () => void;
    let signalActivation!: () => void;
    const activationStarted = new Promise<void>((resolve) => {
        signalActivation = resolve;
    });
    const descriptor = reverseDescriptor(async () => {
        signalActivation();
        await new Promise<void>((resolve) => {
            releaseActivation = resolve;
        });
        return reverseSnapshot();
    });
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: { get: (name) => name === descriptor.name ? descriptor : undefined },
        publicBaseUrl: "https://example.test"
    });
    const credentialService = new ReverseCredentialService({
        credentialStore,
        instanceRegistry: { get: (name) => name === descriptor.name ? descriptor : undefined },
        publicBaseUrl: "https://example.test"
    });
    credentialService.setDisconnectHandler((instance) => service.disconnect(instance));
    const code = await credentialStore.createDeviceCode(descriptor.name);
    const enrollment = await service.enroll({
        arch: "x86_64",
        deviceCode: code.deviceCode,
        os: "linux",
        workerVersion: "test"
    }) as Record<string, JsonValue>;
    const identity = await service.authenticate(
        descriptor.name,
        1,
        enrollment.deviceToken as string
    );
    const channel = new MemoryRpcChannel();
    const activation = service.activate(identity, "wss", channel);
    await activationStarted;
    await credentialService.rotateDeviceToken(descriptor.name);

    assert.equal(channel.closed, true);
    releaseActivation();
    await assert.rejects(
        activation,
        (error: unknown) => hasCode(error, "reverse.connectionSuperseded")
    );
});

test("ReverseConnectionService rejects queued activation after stop", async () => {
    const home = await createTestTempDirectory("reverse-stop-activation");
    const credentialStore = new ReverseCredentialStore(home);
    let accepted = 0;
    let releaseFirst!: () => void;
    let signalFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
        signalFirst = resolve;
    });
    const descriptor = reverseDescriptor(async (_channel, options) => {
        accepted += 1;
        if (options.generation === 1) {
            signalFirst();
            await new Promise<void>((resolve) => {
                releaseFirst = resolve;
            });
        }
        return reverseSnapshot();
    });
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: { get: (name) => name === descriptor.name ? descriptor : undefined },
        publicBaseUrl: "https://example.test"
    });
    const code = await credentialStore.createDeviceCode(descriptor.name);
    const enrollment = await service.enroll({
        arch: "x86_64",
        deviceCode: code.deviceCode,
        os: "linux",
        workerVersion: "test"
    }) as Record<string, JsonValue>;
    const token = enrollment.deviceToken as string;
    const firstIdentity = await service.authenticate(descriptor.name, 1, token);
    const secondIdentity = await service.authenticate(descriptor.name, 2, token);
    const firstChannel = new MemoryRpcChannel();
    const secondChannel = new MemoryRpcChannel();
    const first = service.activate(firstIdentity, "wss", firstChannel);
    void first.catch(() => undefined);
    await firstStarted;
    const second = service.activate(secondIdentity, "wss", secondChannel);
    void second.catch(() => undefined);

    service.stop();
    releaseFirst();

    await assert.rejects(
        first,
        (error: unknown) => hasCode(error, "reverse.connectionSuperseded")
    );
    await assert.rejects(
        second,
        (error: unknown) => hasCode(error, "reverse.transportUnavailable")
    );
    assert.equal(firstChannel.closed, true);
    assert.equal(secondChannel.closed, true);
    assert.equal(accepted, 1);
});

test("ReverseConnectionService closes the channel when credential activation fails", async () => {
    const descriptor = reverseDescriptor(async () => reverseSnapshot());
    const credentialStore = {
        async withAuthenticatedToken() {
            throw new Error("credential store unavailable");
        }
    } as unknown as ReverseCredentialStore;
    const service = new ReverseConnectionService({
        credentialStore,
        instanceRegistry: { get: (name) => name === descriptor.name ? descriptor : undefined },
        publicBaseUrl: "https://example.test"
    });
    const channel = new MemoryRpcChannel();

    await assert.rejects(
        service.activate({
            credentialToken: "token",
            descriptor,
            generation: 1
        }, "wss", channel),
        /credential store unavailable/iu
    );

    assert.equal(channel.closed, true);
});


function reverseSnapshot(): InstanceSnapshot {
    return {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 0,
        name: asInstanceName("remote-test"),
        ready: true,
        status: "ready"
    };
}

function reverseDescriptor(
    acceptReverseChannel: (
        channel: Channel,
        options: { generation: number; transport: "sse" | "wss" }
    ) => Promise<InstanceSnapshot>
) {
    return {
        name: asInstanceName("remote-test"),
        provider: "reverse" as const,
        reverseConnector: {} as never,
        worker: {
            acceptReverseChannel,
            setReverseEnrollmentState: async (): Promise<InstanceSnapshot> => reverseSnapshot(),
            snapshot: () => ({}) as never
        }
    };
}

function hasCode(error: unknown, code: string): boolean {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === code;
}

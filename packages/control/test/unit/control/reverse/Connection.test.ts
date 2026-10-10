import assert from "node:assert/strict";
import test from "node:test";

import {
    ReverseConnections,
    type Instance,
    type ReverseConnectionIdentity,
} from "@portable-devshell/core";
import {
    asInstanceName,
    type Channel,
} from "@portable-devshell/shared";

import { ReverseCredentials } from "../../../../src/instance/reverse/Credentials.ts";
import { ReverseCredentialStore } from "../../../../src/instance/reverse/credential/Store.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

class MemoryChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    closed = false;

    close(error?: Error): void {
        if (this.closed) return;
        this.closed = true;
        for (const listener of [...this.#closeListeners]) listener(error);
    }

    onClose(listener: (error?: Error) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    onData(): () => void {
        return () => undefined;
    }

    async write(): Promise<void> {}
}

test("reverse credentials own enrollment and token authentication", async () => {
    const home = await createTestTempDirectory("reverse-credentials");
    const descriptor = reverseDescriptor();
    const instances = instanceLookup(descriptor);
    const credentials = new ReverseCredentials({
        credentialStore: new ReverseCredentialStore(home),
        instanceRegistry: instances,
        publicBaseUrl: "https://controller.example.test/base",
    });

    const code = await credentials.createDeviceCode(descriptor.config.name);
    assert.equal(code.controllerUrl, "https://controller.example.test/base");
    const enrolled = await credentials.consumeDeviceCode(code.deviceCode);
    assert.equal(enrolled.instance, descriptor.config.name);
    assert.equal(
        await credentials.authenticate(
            descriptor.config.name,
            enrolled.deviceToken,
        ),
        descriptor,
    );
    await assert.rejects(
        credentials.authenticate(descriptor.config.name, "invalid-token"),
        (error: unknown) => hasCode(error, "reverse.deviceTokenInvalid"),
    );
});

test("core reverse transport owns connection generation replacement", async () => {
    const accepted: number[] = [];
    const descriptor = reverseDescriptor((generation) => {
        accepted.push(generation);
    });
    const connections = new ReverseConnections({
        instances: instanceLookup(descriptor),
    });

    const first = new MemoryChannel();
    const identityOne = identity(descriptor, 1);
    await connections.activate(identityOne, "wss", first);
    assert.deepEqual(accepted, [1]);

    const duplicate = new MemoryChannel();
    await assert.rejects(
        connections.activate(identityOne, "wss", duplicate),
        (error: unknown) => hasCode(error, "reverse.generationInvalid"),
    );
    assert.equal(duplicate.closed, true);

    const second = new MemoryChannel();
    await connections.activate(identity(descriptor, 2), "wss", second);
    assert.deepEqual(accepted, [1, 2]);
    connections.disconnect(descriptor.config.name);
    assert.equal(second.closed, true);
});

test("credential rotation disconnects the active core transport", async () => {
    const home = await createTestTempDirectory("reverse-credential-rotation");
    const descriptor = reverseDescriptor();
    const instances = instanceLookup(descriptor);
    const connections = new ReverseConnections({ instances });
    const credentials = new ReverseCredentials({
        credentialStore: new ReverseCredentialStore(home),
        instanceRegistry: instances,
        publicBaseUrl: "https://controller.example.test",
    });
    credentials.setDisconnectHandler((instance) =>
        connections.disconnect(instance),
    );

    const code = await credentials.createDeviceCode(descriptor.config.name);
    const enrolled = await credentials.consumeDeviceCode(code.deviceCode);
    const channel = new MemoryChannel();
    await credentials.runAuthenticated(
        descriptor.config.name,
        enrolled.deviceToken,
        async () =>
            await connections.activate(identity(descriptor, 1), "wss", channel),
    );

    await credentials.rotateDeviceToken(descriptor.config.name);
    assert.equal(channel.closed, true);
});

function reverseDescriptor(onAttach: (generation: number) => void = () => undefined) {
    // Only the fields observed by ReverseConnections are implemented here.
    const descriptor: Instance = {
        config: {
            name: asInstanceName("remote-test"),
            provider: "reverse" as const,
        },
        lifecycle: {
            acquireLease() {
                return { instance: descriptor, release() {} };
            },
        },
        provision: {
            reverseConnection: {
                async attach(
                    _channel: Channel,
                    input: { generation: number },
                ) {
                    onAttach(input.generation);
                },
            },
        },
    } as unknown as Instance;
    return descriptor;
}

function instanceLookup(descriptor: Instance) {
    return {
        get(name: string) {
            return name === descriptor.config.name ? descriptor : undefined;
        },
    };
}

function identity(descriptor: Instance, generation: number): ReverseConnectionIdentity {
    return { descriptor, generation };
}

function hasCode(error: unknown, code: string): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === code
    );
}

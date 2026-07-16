import assert from "node:assert/strict";
import test from "node:test";

import { errorCodes } from "@portable-devshell/shared";

import {
    readSharePayloadSourceInput,
    readSourceInstance,
    readTransferPayloadSourceInput,
    sourceDescriptor,
    sourceTypeFromPayload,
    validateTransferStart
} from "../../dist/control/artifact/ArtifactSource.js";
import { ReverseCredentialService } from "../../dist/control/reverse/credential/ReverseCredentialService.js";

test("artifact source helpers preserve handle and path variants", () => {
    assert.deepEqual(readSharePayloadSourceInput({ handle: "artifact:stdout:1" }), {
        handle: "artifact:stdout:1"
    });
    assert.deepEqual(readSharePayloadSourceInput({ path: "./result.bin" }), {
        path: "./result.bin"
    });
    assert.deepEqual(
        readTransferPayloadSourceInput({
            handle: "artifact:stdout:1",
            operation: "start",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
        }),
        { handle: "artifact:stdout:1" }
    );
    assert.deepEqual(
        readTransferPayloadSourceInput({
            operation: "start",
            sourcePath: "./result.bin",
            targetInstance: "target-one",
            targetPath: "/tmp/result.bin"
        }),
        { path: "./result.bin" }
    );
});

test("artifact source helpers reject ambiguous or empty sources and missing targets", () => {
    for (const action of [
        () => readSharePayloadSourceInput({ handle: "", path: undefined } as never),
        () => readSharePayloadSourceInput({ handle: "one", path: "./two" } as never),
        () => readTransferPayloadSourceInput({
            handle: "one",
            operation: "start",
            sourcePath: "./two",
            targetInstance: "target",
            targetPath: "/target"
        } as never),
        () => validateTransferStart({
            handle: "one",
            operation: "status",
            targetInstance: "target",
            targetPath: "/target"
        } as never),
        () => validateTransferStart({
            handle: "one",
            operation: "start",
            targetInstance: "",
            targetPath: "/target"
        })
    ]) {
        assertTargetInvalid(action);
    }
});

test("artifact source instance resolution and descriptors retain authority and source type", () => {
    assert.equal(readSourceInstance("explicit", "default"), "explicit");
    assert.equal(readSourceInstance(undefined, "default"), "default");
    assertTargetInvalid(() => readSourceInstance(undefined, ""));

    const bytePayload = {
        mediaType: "application/octet-stream",
        name: "stdout.bin",
        payloadBlake3: "a".repeat(64),
        payloadBytes: 3,
        type: "stdout" as const
    };
    const directoryPayload = {
        entryCount: 2,
        logicalBytes: 4,
        manifestBlake3: "b".repeat(64),
        mediaType: "application/zstd",
        name: "workspace.tar.zst",
        payloadBlake3: "c".repeat(64),
        payloadBytes: 5,
        type: "directoryArchive" as const
    };

    assert.equal(sourceTypeFromPayload(bytePayload), "artifact");
    assert.equal(sourceTypeFromPayload({ ...bytePayload, type: "stderr" }), "artifact");
    assert.equal(sourceTypeFromPayload({ ...bytePayload, type: "file" }), "file");
    assert.equal(sourceTypeFromPayload(directoryPayload), "directory");
    assert.deepEqual(sourceDescriptor("source-one", { handle: "artifact:stdout:1" }, bytePayload), {
        handle: "artifact:stdout:1",
        instance: "source-one",
        type: "artifact"
    });
    assert.deepEqual(sourceDescriptor("source-one", { path: "./workspace" }, directoryPayload), {
        instance: "source-one",
        path: "./workspace",
        type: "directory"
    });
});

test("reverse credential service validates instance existence and provider before touching credentials", async () => {
    const calls: string[] = [];
    const service = new ReverseCredentialService({
        credentialStore: credentialStore(calls),
        instanceRegistry: {
            get(instance: string) {
                if (instance === "local-one") {
                    return { provider: "local" };
                }
                return undefined;
            }
        } as never,
        publicBaseUrl: "https://controller.example/base"
    });

    await assert.rejects(service.createDeviceCode("missing-one"), (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.instanceMissing);
        assert.deepEqual(readField(error, "details"), { instance: "missing-one" });
        return true;
    });
    await assert.rejects(service.rotateDeviceToken("local-one"), (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.reverseInstanceNotReverse);
        assert.deepEqual(readField(error, "details"), { instance: "local-one" });
        return true;
    });
    assert.deepEqual(calls, []);
});

test("reverse credential service coordinates enrollment, rotation, revocation, and disconnect ordering", async () => {
    const calls: string[] = [];
    const worker = {
        async setReverseEnrollmentState(state: string) {
            calls.push(`worker:${state}`);
        }
    };
    const service = new ReverseCredentialService({
        credentialStore: credentialStore(calls),
        instanceRegistry: {
            get(instance: string) {
                return instance === "reverse-one"
                    ? { provider: "reverse", worker }
                    : undefined;
            }
        } as never,
        publicBaseUrl: "https://controller.example/base"
    });
    service.setDisconnectHandler((instance) => calls.push(`disconnect:${instance}`));

    assert.deepEqual(await service.createDeviceCode("reverse-one"), {
        controllerUrl: "https://controller.example/base",
        deviceCode: "ABCDE-FGHIJ",
        expiresAt: "2026-07-16T12:00:00.000Z",
        instance: "reverse-one"
    });
    assert.deepEqual(await service.rotateDeviceToken("reverse-one"), {
        deviceToken: "rotated-token",
        instance: "reverse-one"
    });
    assert.deepEqual(await service.revokeDeviceToken("reverse-one"), {
        instance: "reverse-one",
        revoked: true
    });
    assert.deepEqual(calls, [
        "store:create:reverse-one",
        "worker:pending",
        "store:rotate:reverse-one",
        "disconnect:reverse-one",
        "store:revoke:reverse-one",
        "disconnect:reverse-one",
        "worker:revoked"
    ]);
});

function credentialStore(calls: string[]) {
    return {
        async createDeviceCode(instance: string) {
            calls.push(`store:create:${instance}`);
            return {
                deviceCode: "ABCDE-FGHIJ",
                expiresAt: "2026-07-16T12:00:00.000Z",
                instance
            };
        },
        async revoke(instance: string) {
            calls.push(`store:revoke:${instance}`);
        },
        async rotateToken(instance: string) {
            calls.push(`store:rotate:${instance}`);
            return "rotated-token";
        }
    } as never;
}

function assertTargetInvalid(action: () => unknown): void {
    assert.throws(action, (error: unknown) => {
        assert.equal(readField(error, "code"), errorCodes.targetInvalid);
        assert.equal(readField(error, "retryable"), false);
        return true;
    });
}

function readField(value: unknown, field: string): unknown {
    assert.equal(typeof value, "object");
    assert.notEqual(value, null);
    return (value as Record<string, unknown>)[field];
}

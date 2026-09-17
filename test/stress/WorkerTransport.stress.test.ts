import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import test from "node:test";

import {
    WorkerBinary,
    WorkerInstanceFactory,
    WorkerTransportConnection,
    WorkerTransportDriverLocal,
    WorkerTransportServiceClient,
} from "@portable-devshell/core/testing";
import { asInstanceName } from "@portable-devshell/shared";
import type { FrameStream } from "@portable-devshell/shared/transport/frame";

import { resolveTestWorkerBinary } from "../TestPlatformSupport.ts";
import { createTestTempDirectory } from "../TestTempDirectory.ts";

const workerBinaryPath = resolveTestWorkerBinary();

function payload(byteLength: number, seed: number): Uint8Array {
    const data = new Uint8Array(byteLength);
    for (let index = 0; index < data.length; index += 1) {
        data[index] = (index * 13 + seed * 29) % 251;
    }
    return data;
}

function digest(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
}

async function echoRoundTrip(stream: FrameStream, data: Uint8Array): Promise<void> {
    const writing = stream.write(data).then(async () => await stream.finish());
    const hash = createHash("sha256");
    let bytes = 0;
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) break;
        bytes += chunk.byteLength;
        hash.update(chunk);
    }
    await writing;
    assert.equal(bytes, data.byteLength);
    assert.equal(hash.digest("hex"), digest(data));
}

test("stress: real Rust Worker keeps multiplexed TCP and process streams stable", async (t) => {
    assert.ok(workerBinaryPath, "stress runner must build a real devshell-worker");
    const homeDirectory = await createTestTempDirectory("transport-stress-home");
    const runtimeDirectory = await createTestTempDirectory("transport-stress-runtime");
    const instanceName = `transport-stress-${process.pid}`;
    const env = {
        ...process.env,
        HOME: homeDirectory,
        USERPROFILE: homeDirectory,
        XDG_RUNTIME_DIR: runtimeDirectory,
    };
    const transport = new WorkerTransportDriverLocal({
        workerBinary: new WorkerBinary(workerBinaryPath),
    });
    const options = { env, instanceName };
    const connection = WorkerTransportConnection.fromTransport(transport, options);
    const services = new WorkerTransportServiceClient(connection);
    const echoServer = createServer((socket) => socket.pipe(socket));

    t.after(async () => {
        connection.close();
        await new Promise<void>((resolve) => echoServer.close(() => resolve()));
        await transport.runWorkerCommand("stop", options).catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(runtimeDirectory, { force: true, recursive: true });
    });

    const started = await transport.runWorkerCommand("start", options);
    assert.equal(started.exitCode, 0);
    await new Promise<void>((resolve, reject) => {
        echoServer.once("error", reject);
        echoServer.listen(0, "127.0.0.1", resolve);
    });
    const address = echoServer.address();
    assert.ok(address !== null && typeof address !== "string");

    await Promise.all(
        Array.from({ length: 24 }, async (_, index) => {
            const stream = await services.execProcess({ executable: "/bin/cat" });
            await echoRoundTrip(stream, payload(1024 * 1024, index));
        }),
    );

    await Promise.all(
        Array.from({ length: 32 }, async (_, index) => {
            const stream = await services.connectTcp({
                host: "127.0.0.1",
                port: address.port,
            });
            await echoRoundTrip(stream, payload(1024 * 1024, index + 100));
        }),
    );

    const large = await services.execProcess({ executable: "/bin/cat" });
    await echoRoundTrip(large, payload(16 * 1024 * 1024, 999));

    for (let index = 0; index < 256; index += 1) {
        const stream = await services.execProcess({ executable: "/bin/cat" });
        await echoRoundTrip(stream, Uint8Array.of(index & 0xff));
    }

    const finalStream = await services.execProcess({ executable: "/bin/cat" });
    await echoRoundTrip(finalStream, new TextEncoder().encode("still-alive"));
});

test("stress: real Artifact Frame services round-trip 32 MiB without breaking RPC", async (t) => {
    assert.ok(workerBinaryPath, "stress runner must build a real devshell-worker");
    const workspace = await createTestTempDirectory("artifact-stress-workspace");
    const homeDirectory = await createTestTempDirectory("artifact-stress-home");
    const runtimeDirectory = await createTestTempDirectory("artifact-stress-runtime");
    const instanceName = asInstanceName(`artifact-stress-${process.pid}`);
    const source = payload(32 * 1024 * 1024, 4242);
    await writeFile(`${workspace}/source.bin`, source);

    const instance = new WorkerInstanceFactory().create({
        env: {
            ...process.env,
            HOME: homeDirectory,
            USERPROFILE: homeDirectory,
            XDG_RUNTIME_DIR: runtimeDirectory,
        },
        homeDirectory,
        name: instanceName,
        transport: new WorkerTransportDriverLocal({
            workerBinary: new WorkerBinary(workerBinaryPath),
        }),
    });
    t.after(async () => {
        await instance.stop().catch(() => undefined);
        await instance.close().catch(() => undefined);
        await rm(workspace, { force: true, recursive: true });
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(runtimeDirectory, { force: true, recursive: true });
    });

    await instance.start();
    const opened = await instance.openArtifactPayload({
        expiresAtMs: Date.now() + 120_000,
        path: "./source.bin",
        workspace,
    });
    const receive = await instance.beginArtifactReceive({
        descriptor: opened.descriptor,
        overwrite: false,
        targetPath: "./copy.bin",
        workspace,
    });
    const sourceHash = createHash("sha256");
    let offsetBytes = 0;
    while (offsetBytes < source.byteLength) {
        const chunk = await instance.readArtifactPayload({
            maxBytes: 1024 * 1024,
            offsetBytes,
            payloadId: opened.payloadId,
        });
        const content = Buffer.from(chunk.content, "base64");
        assert.ok(content.byteLength > 0);
        assert.ok(content.byteLength <= 1024 * 1024);
        sourceHash.update(content);
        const written = await instance.writeArtifactReceive({
            content: chunk.content,
            offsetBytes,
            receiveId: receive.receiveId,
        });
        offsetBytes = written.nextOffsetBytes;
    }
    assert.equal(offsetBytes, source.byteLength);
    assert.equal(sourceHash.digest("hex"), digest(source));
    const finished = await instance.finishArtifactReceive(receive.receiveId);
    assert.equal(finished.bytes, source.byteLength);
    assert.equal(digest(await readFile(`${workspace}/copy.bin`)), digest(source));
    await instance.closeArtifactPayload(opened.payloadId);
    assert.equal(instance.snapshot().ready, true);
});

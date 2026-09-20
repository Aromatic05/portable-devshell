import assert from "node:assert/strict";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactHostPayloadStore } from "../../../../../src/control/artifact/host/storage/PayloadStore.ts";
import { ArtifactHostReceiveStore } from "../../../../../src/control/artifact/host/storage/ReceiveStore.ts";
import type { ArtifactHostAccessContext } from "../../../../../src/control/artifact/host/Model.ts";
import { createTestTempDirectory } from "../../../../../../../test/TestTempDirectory.ts";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function accessContext(): ArtifactHostAccessContext {
    return {
        appendControlEvent: async () => undefined,
        authorityInstance: "demo-local",
        provider: "local",
        securityMode: "disabled",
    };
}

test("host payload TTL and active-count bounds release capacity on close", async (t) => {
    const root = await createTestTempDirectory("artifact-host-payload-limits-");
    const homeDirectory = join(root, "home");
    const workspace = join(root, "workspace");
    const payloadRoot = join(root, "payloads");
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "payload.txt"), "payload");
    const store = new ArtifactHostPayloadStore({
        homeDirectory,
        maxActivePayloads: 1,
        root: payloadRoot,
    });
    await store.initialize();

    await assert.rejects(
        store.openPath(
            "./payload.txt",
            Date.now() + SEVEN_DAYS_MS + 60_000,
            workspace,
            accessContext(),
        ),
        (error: unknown) =>
            (error as { code?: string }).code === "artifact.invalidLease",
    );

    const competing = await Promise.allSettled([
        store.openPath(
            "./payload.txt",
            Date.now() + 60_000,
            workspace,
            accessContext(),
        ),
        store.openPath(
            "./payload.txt",
            Date.now() + 60_000,
            workspace,
            accessContext(),
        ),
    ]);
    const admitted = competing.filter(
        (result) => result.status === "fulfilled",
    );
    const rejected = competing.filter((result) => result.status === "rejected");
    assert.equal(admitted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal(
        (rejected[0] as PromiseRejectedResult).reason.code,
        "artifact.quotaExceeded",
    );
    const first = (admitted[0] as PromiseFulfilledResult<{ payloadId: string }>)
        .value;
    await store.close(first.payloadId);
    const reopened = await store.openPath(
        "./payload.txt",
        Date.now() + 60_000,
        workspace,
        accessContext(),
    );
    await store.close(reopened.payloadId);
    t.after(() => rm(root, { force: true, recursive: true }));
});

test("host receive active-count bound releases capacity on abort", async (t) => {
    const root = await createTestTempDirectory("artifact-host-receive-limits-");
    const downloadDirectory = join(root, "Download");
    const store = new ArtifactHostReceiveStore({
        downloadDirectory,
        maxActiveReceives: 1,
        root: join(root, "receives"),
    });
    await store.initialize();
    const descriptor = {
        mediaType: "application/octet-stream",
        name: "empty.bin",
        payloadBlake3: "0".repeat(64),
        payloadBytes: 0,
        type: "file" as const,
    };

    const first = await store.begin({
        descriptor,
        overwrite: false,
        targetPath: "./first.bin",
        workspace: root,
    });
    await assert.rejects(
        store.begin({
            descriptor,
            overwrite: false,
            targetPath: "./second.bin",
            workspace: root,
        }),
        (error: unknown) =>
            (error as { code?: string }).code === "artifact.quotaExceeded",
    );
    await store.abort(first.receiveId);
    const reopened = await store.begin({
        descriptor,
        overwrite: false,
        targetPath: "./reopened.bin",
        workspace: root,
    });
    await store.abort(reopened.receiveId);
    t.after(() => rm(root, { force: true, recursive: true }));
});

test("host receive abort is idempotent only when metadata is absent", async (t) => {
    const root = await createTestTempDirectory("artifact-host-receive-abort-");
    const downloadDirectory = join(root, "Download");
    const receiveRoot = join(root, "receives");
    const receiveId = "00000000-0000-4000-8000-000000000004";
    const store = new ArtifactHostReceiveStore({
        downloadDirectory,
        root: receiveRoot,
    });
    await store.initialize();

    await store.abort(receiveId);
    await mkdir(join(receiveRoot, `${receiveId}.json`));
    await assert.rejects(
        store.abort(receiveId),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
    );
    t.after(() => rm(root, { force: true, recursive: true }));
});

test("host receive recovery preserves metadata and backup on non-ENOENT lstat errors", async (t) => {
    const root = await createTestTempDirectory("artifact-host-receive-recovery-io-");
    const downloadDirectory = join(root, "Download");
    const receiveRoot = join(root, "receives");
    const temporaryDirectory = join(downloadDirectory, ".devshell-receive");
    const receiveId = "00000000-0000-4000-8000-000000000003";
    await mkdir(downloadDirectory, { recursive: true });
    await writeFile(join(downloadDirectory, "blocked"), "not-a-directory");
    await mkdir(receiveRoot, { recursive: true });
    await mkdir(temporaryDirectory, { recursive: true });
    const backupPath = join(temporaryDirectory, `${receiveId}.backup`);
    await writeFile(backupPath, "backup");
    await writeFile(
        join(receiveRoot, `${receiveId}.json`),
        JSON.stringify({
            backupPath,
            descriptor: {
                mediaType: "application/octet-stream",
                name: "payload.bin",
                payloadBlake3: "0".repeat(64),
                payloadBytes: 0,
                type: "file",
            },
            overwrite: true,
            phase: "committing",
            receiveId,
            receivedBytes: 0,
            targetPath: join(downloadDirectory, "blocked", "target.bin"),
            temporaryPath: join(temporaryDirectory, `${receiveId}.payload`),
            version: 1,
        }),
    );

    const store = new ArtifactHostReceiveStore({
        downloadDirectory,
        root: receiveRoot,
    });
    await assert.rejects(store.initialize(), (error: unknown) =>
        ["ENOTDIR", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? ""),
    );
    assert.deepEqual(await readdir(receiveRoot), [`${receiveId}.json`]);
    assert.deepEqual(await readdir(temporaryDirectory), [`${receiveId}.backup`]);
    t.after(() => rm(root, { force: true, recursive: true }));
});

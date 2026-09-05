import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactHostPayloadStore } from "../../src/control/artifact/host/ArtifactHostPayloadStore.ts";
import { ArtifactHostReceiveStore } from "../../src/control/artifact/host/ArtifactHostReceiveStore.ts";
import type { ArtifactHostAccessContext } from "../../src/control/artifact/host/ArtifactHostModel.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

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
        (error: unknown) => (error as { code?: string }).code === "artifact.invalidLease",
    );

    const competing = await Promise.allSettled([
        store.openPath("./payload.txt", Date.now() + 60_000, workspace, accessContext()),
        store.openPath("./payload.txt", Date.now() + 60_000, workspace, accessContext()),
    ]);
    const admitted = competing.filter((result) => result.status === "fulfilled");
    const rejected = competing.filter((result) => result.status === "rejected");
    assert.equal(admitted.length, 1);
    assert.equal(rejected.length, 1);
    assert.equal((rejected[0] as PromiseRejectedResult).reason.code, "artifact.quotaExceeded");
    const first = (admitted[0] as PromiseFulfilledResult<{ payloadId: string }>).value;
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
        (error: unknown) => (error as { code?: string }).code === "artifact.quotaExceeded",
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

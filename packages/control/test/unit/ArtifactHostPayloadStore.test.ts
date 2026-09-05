import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactHostPayloadStore } from "../../src/control/artifact/host/ArtifactHostPayloadStore.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("host payload startup defers expired maintenance without weakening lease enforcement", async (t) => {
    const root = await createTestTempDirectory("artifact-host-payload-maintenance-");
    const payloadRoot = join(root, "payloads");
    const payloadId = "00000000-0000-4000-8000-000000000001";
    await mkdir(payloadRoot, { recursive: true });
    await writeFile(join(payloadRoot, `${payloadId}.bin`), Buffer.alloc(0));
    await writeFile(join(payloadRoot, `${payloadId}.json`), JSON.stringify({
        descriptor: {
            mediaType: "application/octet-stream",
            name: "expired.bin",
            payloadBlake3: "expired",
            payloadBytes: 0,
            type: "file",
        },
        expiresAtMs: Date.now() - 1,
        payloadId,
        version: 1,
    }));

    const store = new ArtifactHostPayloadStore({ homeDirectory: root, root: payloadRoot });
    await store.initialize();

    await assert.rejects(
        store.read(payloadId, 0, 1),
        (error: unknown) => (error as { code?: string }).code === "artifact.payloadExpired",
    );
    t.after(() => rm(root, { force: true, recursive: true }));
});

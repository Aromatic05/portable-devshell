import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ArtifactRecordStore } from "../../../../src/control/artifact/RecordStore.ts";
import { createTestTempDirectory } from "../../../../../../test/TestTempDirectory.ts";

test("artifact record loading skips deliberate JSON corruption but surfaces I/O errors", async (t) => {
    const root = await createTestTempDirectory("artifact-records-");
    const store = new ArtifactRecordStore(root);
    await store.initialize();
    await writeFile(join(root, "shares", "corrupt.json"), "{");
    await mkdir(join(root, "shares", "io.json"));

    await assert.rejects(
        store.loadShares(),
        (error: unknown) => (error as NodeJS.ErrnoException).code === "EISDIR",
    );
    t.after(() => rm(root, { force: true, recursive: true }));
});

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { cleanupStaleAtomicStateTemps } from "../../src/instance/AtomicStateFile.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("atomic state cleanup removes only dead-owner sibling temps", async () => {
    const root = await createTestTempDirectory("atomic-state-temp-cleanup");
    const filePath = join(root, "waits.json");
    const dead = `${filePath}.tmp.1001.${randomUUID()}`;
    const live = `${filePath}.tmp.1002.${randomUUID()}`;
    const otherState = join(root, `todo.json.tmp.1001.${randomUUID()}`);
    const malformed = `${filePath}.tmp.1001.not-a-uuid`;

    try {
        await mkdir(root, { recursive: true });
        await Promise.all([
            writeFile(dead, "dead"),
            writeFile(live, "live"),
            writeFile(otherState, "other"),
            writeFile(malformed, "malformed"),
        ]);

        cleanupStaleAtomicStateTemps(filePath, (pid) => pid === 1002);

        await assert.rejects(access(dead));
        await assert.doesNotReject(access(live));
        await assert.doesNotReject(access(otherState));
        await assert.doesNotReject(access(malformed));
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

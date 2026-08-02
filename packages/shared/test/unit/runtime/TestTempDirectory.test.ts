import assert from "node:assert/strict";
import { rm, stat, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import test from "node:test";

import {
    cleanupTestTempDirectories,
    createTestTempDirectory,
    resolveTestTempNamespace
} from "../../../../../test/TestTempDirectory.ts";

test("test temp directories live under the devshell-test namespace", async (t) => {
    const directory = await createTestTempDirectory("namespace-probe");
    t.after(async () => await rm(directory, { force: true, recursive: true }));

    const namespace = await resolveTestTempNamespace();
    const relativePath = relative(namespace, directory);
    assert.ok(relativePath.length > 0, directory);
    assert.equal(relativePath.includes(".."), false, directory);
    assert.equal(dirname(directory), namespace);
    assert.match(relativePath, /^namespace-probe-/u);

    await writeFile(`${directory}/marker.txt`, "present", "utf8");
    assert.equal((await stat(`${directory}/marker.txt`)).isFile(), true);
});

test("concurrent test temp directories never collide", async (t) => {
    const directories = await Promise.all(
        Array.from({ length: 16 }, () => createTestTempDirectory("concurrent"))
    );
    t.after(async () => {
        await Promise.all(directories.map((directory) => rm(directory, { force: true, recursive: true })));
    });

    const namespace = await resolveTestTempNamespace();
    assert.equal(new Set(directories).size, directories.length);
    await Promise.all(directories.map(async (directory, index) => {
        assert.equal(dirname(directory), namespace);
        await writeFile(`${directory}/marker.txt`, String(index), "utf8");
    }));
    const markers = await Promise.all(directories.map((directory) => stat(`${directory}/marker.txt`)));
    assert.equal(markers.every((entry) => entry.isFile()), true);
});

test("cleaning one test temp directory leaves siblings intact", async (t) => {
    const first = await createTestTempDirectory("cleanup-first");
    const second = await createTestTempDirectory("cleanup-second");
    t.after(async () => await rm(second, { force: true, recursive: true }));

    await writeFile(`${first}/marker.txt`, "first", "utf8");
    await writeFile(`${second}/marker.txt`, "second", "utf8");
    await rm(first, { force: true, recursive: true });

    await assert.rejects(stat(`${first}/marker.txt`));
    assert.equal((await stat(`${second}/marker.txt`)).isFile(), true);
});

test("process cleanup removes every directory registered by the helper", async () => {
    const first = await createTestTempDirectory("process-cleanup-first");
    const second = await createTestTempDirectory("process-cleanup-second");
    await writeFile(`${first}/marker.txt`, "first", "utf8");
    await writeFile(`${second}/marker.txt`, "second", "utf8");

    cleanupTestTempDirectories();

    await assert.rejects(stat(first));
    await assert.rejects(stat(second));
});

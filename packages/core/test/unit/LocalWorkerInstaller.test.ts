import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalWorkerInstaller, getWorkerTargetByKey, type WorkerAsset } from "@portable-devshell/core";

test("LocalWorkerInstaller installs into target-specific directory and refreshes symlink", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-home-"));
    const workerDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-worker-"));
    t.after(async () => {
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const binaryPath = join(workerDirectory, "devshell-worker");
    const contents = Buffer.from("#!/bin/sh\necho local\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents, { mode: 0o755 });

    const target = getWorkerTargetByKey("darwin-arm64");
    const installer = new LocalWorkerInstaller();
    const executable = await installer.ensure(homeDirectory, createAsset(binaryPath, sha256, target), target);

    assert.equal(executable, join(homeDirectory, ".devshell", "bin", "devshell-worker"));
    assert.equal(await readFile(join(homeDirectory, ".devshell", "workers", target.key, sha256, "devshell-worker"), "utf8"), contents.toString("utf8"));
    assert.equal(await readlink(executable), `../workers/${target.key}/${sha256}/devshell-worker`);
});

test("LocalWorkerInstaller rejects asset target mismatch", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-home-"));
    const workerDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-worker-"));
    t.after(async () => {
        await rm(homeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const binaryPath = join(workerDirectory, "devshell-worker");
    const contents = Buffer.from("#!/bin/sh\necho local\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents, { mode: 0o755 });

    const installer = new LocalWorkerInstaller();
    const requestedTarget = getWorkerTargetByKey("linux-x64");
    const assetTarget = getWorkerTargetByKey("darwin-arm64");

    await assert.rejects(installer.ensure(homeDirectory, createAsset(binaryPath, sha256, assetTarget), requestedTarget), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerProvisionFailed");
        assert.deepEqual((error as { details?: Record<string, unknown> }).details, {
            assetTargetKey: "darwin-arm64",
            targetKey: "linux-x64"
        });
        return true;
    });
});

function createAsset(binaryPath: string, sha256: string, target: ReturnType<typeof getWorkerTargetByKey>): WorkerAsset {
    return {
        binaryPath,
        searchedPaths: [binaryPath],
        sha256,
        source: "env",
        target
    };
}

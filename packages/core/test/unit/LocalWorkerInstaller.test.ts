import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readlink, rename, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { WorkerInstallerLocal, getWorkerTargetByKey, type WorkerAsset } from "@portable-devshell/core/testing";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("WorkerInstallerLocal returns an executable pinned to the installed asset", { skip: process.platform === "win32" ? "requires Unix executable semantics" : false }, async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home");
    const workerDirectory = await createTestTempDirectory("worker");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const binaryPath = join(workerDirectory, "devshell-worker");
    const contents = Buffer.from("#!/bin/sh\necho local\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents, { mode: 0o755 });

    const target = getWorkerTargetByKey("darwin-arm64");
    const installer = new WorkerInstallerLocal();
    const executable = await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);

    assert.equal(await readFile(executable, "utf8"), contents.toString("utf8"));
    assert.equal(execFileSync(executable, { encoding: "utf8" }).trim(), "local");
});

test("WorkerInstallerLocal pins each concurrent Unix install to its requested asset", { skip: process.platform === "win32" ? "Unix aliases are not used on Windows" : false }, async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-concurrent-assets");
    const workerDirectory = await createTestTempDirectory("worker-concurrent-assets");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const target = getWorkerTargetByKey("linux-x64");
    const firstPath = join(workerDirectory, "worker-a");
    const secondPath = join(workerDirectory, "worker-b");
    const first = Buffer.from("worker-a", "utf8");
    const second = Buffer.from("worker-b", "utf8");
    const firstSha = createHash("sha256").update(first).digest("hex");
    const secondSha = createHash("sha256").update(second).digest("hex");
    await writeFile(firstPath, first, { mode: 0o755 });
    await writeFile(secondPath, second, { mode: 0o755 });

    const [firstExecutable, secondExecutable] = await Promise.all([
        new WorkerInstallerLocal().ensure(
            devshellHomeDirectory,
            createAsset(firstPath, firstSha, target),
            target
        ),
        new WorkerInstallerLocal().ensure(
            devshellHomeDirectory,
            createAsset(secondPath, secondSha, target),
            target
        )
    ]);

    assert.notEqual(firstExecutable, secondExecutable);
    assert.equal(await readFile(firstExecutable, "utf8"), first.toString("utf8"));
    assert.equal(await readFile(secondExecutable, "utf8"), second.toString("utf8"));
});

test("WorkerInstallerLocal prunes stale worker generations only after successful activation", { skip: process.platform === "win32" ? "requires Unix symlink semantics" : false }, async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-generation-gc");
    const workerDirectory = await createTestTempDirectory("worker-generation-gc");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const target = getWorkerTargetByKey("linux-x64");
    const generations = join(devshellHomeDirectory, "workers", target.key);
    const stale = join(generations, "a".repeat(64));
    const recent = join(generations, "b".repeat(64));
    const unknown = join(generations, "manual-backup");
    await Promise.all([
        mkdir(stale, { recursive: true }),
        mkdir(recent, { recursive: true }),
        mkdir(unknown, { recursive: true }),
    ]);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await Promise.all([utimes(stale, old, old), utimes(unknown, old, old)]);

    const binaryPath = join(workerDirectory, "worker-current");
    const contents = Buffer.from("worker-current", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents, { mode: 0o755 });
    const installer = new WorkerInstallerLocal();
    await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);

    await assert.rejects(access(stale));
    await assert.doesNotReject(access(recent));
    await assert.doesNotReject(access(unknown));
    const currentGeneration = join(generations, sha256);
    await assert.doesNotReject(access(currentGeneration));

    await utimes(currentGeneration, old, old);
    await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);
    const nextPath = join(workerDirectory, "worker-next");
    const nextContents = Buffer.from("worker-next", "utf8");
    const nextSha256 = createHash("sha256").update(nextContents).digest("hex");
    await writeFile(nextPath, nextContents, { mode: 0o755 });
    await installer.ensure(devshellHomeDirectory, createAsset(nextPath, nextSha256, target), target);
    await assert.doesNotReject(access(currentGeneration));
});

test("WorkerInstallerLocal repairs corrupted content and preserves the old alias when activation fails", { skip: process.platform === "win32" ? "requires Unix symlink semantics" : false }, async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-repair");
    const workerDirectory = await createTestTempDirectory("worker-repair");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const target = getWorkerTargetByKey("linux-x64");
    const firstPath = join(workerDirectory, "worker-v1");
    const first = Buffer.from("worker-v1", "utf8");
    const firstSha = createHash("sha256").update(first).digest("hex");
    await writeFile(firstPath, first, { mode: 0o755 });
    const installer = new WorkerInstallerLocal();
    await installer.ensure(devshellHomeDirectory, createAsset(firstPath, firstSha, target), target);
    const alias = join(devshellHomeDirectory, "bin", `devshell-worker-${target.key}`);
    const previousTarget = await readlink(alias);

    const installed = join(devshellHomeDirectory, "workers", target.key, firstSha, "devshell-worker");
    await writeFile(installed, "corrupt", "utf8");
    await installer.ensure(devshellHomeDirectory, createAsset(firstPath, firstSha, target), target);
    assert.equal(await readFile(installed, "utf8"), first.toString("utf8"));

    const secondPath = join(workerDirectory, "worker-v2");
    const second = Buffer.from("worker-v2", "utf8");
    const secondSha = createHash("sha256").update(second).digest("hex");
    await writeFile(secondPath, second, { mode: 0o755 });
    const stale = join(devshellHomeDirectory, "workers", target.key, "c".repeat(64));
    await mkdir(stale, { recursive: true });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1_000);
    await utimes(stale, old, old);
    const failing = new WorkerInstallerLocal({
        fileSystem: {
            rename: async (source, destination) => {
                if (String(source).includes(".next-") && destination === alias) {
                    throw new Error("injected alias activation failure");
                }
                await rename(source, destination);
            },
        },
    });

    await assert.rejects(
        failing.ensure(devshellHomeDirectory, createAsset(secondPath, secondSha, target), target),
        /injected alias activation failure/u,
    );
    assert.equal(await readlink(alias), previousTarget);
    await assert.doesNotReject(access(stale));
});

test("WorkerInstallerLocal rejects a bundle whose declared checksum does not match its bytes", async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-mismatch");
    const workerDirectory = await createTestTempDirectory("worker-mismatch");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });
    const binaryPath = join(workerDirectory, "devshell-worker");
    await writeFile(binaryPath, "actual-worker", { mode: 0o755 });
    const target = getWorkerTargetByKey("linux-x64");

    await assert.rejects(
        new WorkerInstallerLocal().ensure(
            devshellHomeDirectory,
            createAsset(binaryPath, "0".repeat(64), target),
            target,
        ),
        (error: unknown) => (error as { code?: string }).code === "core.workerProvisionFailed",
    );
});

test("WorkerInstallerLocal installs and replaces a Windows executable without requiring symlink privileges", async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home");
    const workerDirectory = await createTestTempDirectory("worker");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const binaryPath = join(workerDirectory, "devshell-worker.exe");
    const contents = Buffer.from("windows-worker", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents);

    const target = getWorkerTargetByKey("windows-arm64");
    const installer = new WorkerInstallerLocal();
    const executable = await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);

    assert.equal(executable, join(devshellHomeDirectory, "workers", target.key, sha256, "devshell-worker.exe"));
    assert.equal(
        await readFile(join(devshellHomeDirectory, "workers", target.key, sha256, "devshell-worker.exe"), "utf8"),
        contents.toString("utf8")
    );
    assert.equal(
        await readFile(join(devshellHomeDirectory, "bin", `devshell-worker-${target.key}.exe`), "utf8"),
        contents.toString("utf8")
    );

    const nextContents = Buffer.from("windows-worker-v2", "utf8");
    const nextSha256 = createHash("sha256").update(nextContents).digest("hex");
    await writeFile(binaryPath, nextContents);
    const nextExecutable = await installer.ensure(
        devshellHomeDirectory,
        createAsset(binaryPath, nextSha256, target),
        target,
    );
    assert.equal(
        nextExecutable,
        join(devshellHomeDirectory, "workers", target.key, nextSha256, "devshell-worker.exe"),
    );
    assert.equal(
        await readFile(join(devshellHomeDirectory, "bin", `devshell-worker-${target.key}.exe`), "utf8"),
        nextContents.toString("utf8"),
    );
});

test("WorkerInstallerLocal repairs corrupted Windows target content before activation", async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-windows-repair");
    const workerDirectory = await createTestTempDirectory("worker-windows-repair");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const target = getWorkerTargetByKey("windows-x64");
    const binaryPath = join(workerDirectory, "devshell-worker.exe");
    const contents = Buffer.from("windows-worker-repair", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents);

    const installer = new WorkerInstallerLocal();
    await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);
    const installed = join(
        devshellHomeDirectory,
        "workers",
        target.key,
        sha256,
        "devshell-worker.exe",
    );
    await writeFile(installed, "corrupt", "utf8");

    await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, target), target);

    assert.equal(await readFile(installed, "utf8"), contents.toString("utf8"));
    assert.equal(
        await readFile(join(devshellHomeDirectory, "bin", `devshell-worker-${target.key}.exe`), "utf8"),
        contents.toString("utf8"),
    );
});

test("WorkerInstallerLocal preserves the active Windows alias when replacement activation fails", async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home-windows-activation");
    const workerDirectory = await createTestTempDirectory("worker-windows-activation");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const target = getWorkerTargetByKey("windows-x64");
    const binaryPath = join(workerDirectory, "devshell-worker.exe");
    const first = Buffer.from("windows-worker-v1", "utf8");
    const firstSha = createHash("sha256").update(first).digest("hex");
    await writeFile(binaryPath, first);
    const installer = new WorkerInstallerLocal();
    await installer.ensure(devshellHomeDirectory, createAsset(binaryPath, firstSha, target), target);
    const alias = join(devshellHomeDirectory, "bin", `devshell-worker-${target.key}.exe`);
    assert.equal(await readFile(alias, "utf8"), first.toString("utf8"));

    const second = Buffer.from("windows-worker-v2", "utf8");
    const secondSha = createHash("sha256").update(second).digest("hex");
    await writeFile(binaryPath, second);
    const failing = new WorkerInstallerLocal({
        fileSystem: {
            rename: async (source, destination) => {
                if (String(source).includes(".next-") && destination === alias) {
                    throw new Error("injected Windows alias activation failure");
                }
                await rename(source, destination);
            },
        },
    });

    await assert.rejects(
        failing.ensure(devshellHomeDirectory, createAsset(binaryPath, secondSha, target), target),
        /injected Windows alias activation failure/u,
    );
    assert.equal(await readFile(alias, "utf8"), first.toString("utf8"));
});

test("WorkerInstallerLocal rejects asset target mismatch", async (t) => {
    const devshellHomeDirectory = await createTestTempDirectory("home");
    const workerDirectory = await createTestTempDirectory("worker");
    t.after(async () => {
        await rm(devshellHomeDirectory, { recursive: true, force: true });
        await rm(workerDirectory, { recursive: true, force: true });
    });

    const binaryPath = join(workerDirectory, "devshell-worker");
    const contents = Buffer.from("#!/bin/sh\necho local\n", "utf8");
    const sha256 = createHash("sha256").update(contents).digest("hex");
    await writeFile(binaryPath, contents, { mode: 0o755 });

    const installer = new WorkerInstallerLocal();
    const requestedTarget = getWorkerTargetByKey("linux-x64");
    const assetTarget = getWorkerTargetByKey("darwin-arm64");

    await assert.rejects(installer.ensure(devshellHomeDirectory, createAsset(binaryPath, sha256, assetTarget), requestedTarget), (error: unknown) => {
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

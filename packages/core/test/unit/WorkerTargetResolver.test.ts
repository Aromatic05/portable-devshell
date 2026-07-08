import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
    WorkerAssetResolver,
    getWorkerTargetByKey,
    mapUnameWorkerTarget,
    probeLocalWorkerTarget,
    supportedWorkerTargets
} from "@portable-devshell/core";

test("WorkerTargetMapper maps supported uname values to canonical keys", () => {
    assert.equal(mapUnameWorkerTarget({ provider: "ssh", operation: "probeTarget", rawOs: "Linux", rawArch: "x86_64" }).key, "linux-x64");
    assert.equal(mapUnameWorkerTarget({ provider: "ssh", operation: "probeTarget", rawOs: "Linux", rawArch: "aarch64" }).key, "linux-arm64");
    assert.equal(mapUnameWorkerTarget({ provider: "ssh", operation: "probeTarget", rawOs: "Darwin", rawArch: "arm64" }).key, "darwin-arm64");
    assert.equal(mapUnameWorkerTarget({ provider: "ssh", operation: "probeTarget", rawOs: "Darwin", rawArch: "x86_64" }).key, "darwin-x64");
});

test("WorkerTargetMapper rejects unsupported uname values with structured error", () => {
    assert.throws(
        () => mapUnameWorkerTarget({ provider: "ssh", operation: "probeTarget", rawOs: "FreeBSD", rawArch: "riscv64" }),
        (error: unknown) => {
            assert.ok(typeof error === "object" && error !== null);
            assert.equal((error as { code?: string }).code, "core.workerTargetUnsupported");
            assert.deepEqual((error as { details?: { supportedTargets?: string[] } }).details?.supportedTargets, [
                "linux-x64",
                "linux-arm64",
                "darwin-x64",
                "darwin-arm64"
            ]);
            return true;
        }
    );
});

test("WorkerAssetResolver prefers target-specific env var over package asset", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("darwin-arm64");
    const envPath = join(fixture.root, "env", "devshell-worker");
    await writeExecutable(envPath, "#!/bin/sh\necho env\n");
    await writeExecutable(join(fixture.root, "assets", "workers", target.key, "devshell-worker"), "#!/bin/sh\necho package\n");

    const previous = process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH;
    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = envPath;
    t.after(() => restoreEnv("PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH", previous));

    const asset = await fixture.resolver.resolve(target);

    assert.equal(asset.binaryPath, envPath);
    assert.equal(asset.source, "env");
    assert.equal(asset.target.key, "darwin-arm64");
    assert.deepEqual(asset.searchedPaths, [envPath]);
});

test("WorkerAssetResolver resolves package asset from target-specific directory", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("linux-arm64");
    const binaryPath = join(fixture.root, "assets", "workers", target.key, "devshell-worker");
    const contents = "#!/bin/sh\necho package\n";
    await writeExecutable(binaryPath, contents);

    const asset = await fixture.resolver.resolve(target);

    assert.equal(asset.binaryPath, binaryPath);
    assert.equal(asset.source, "package");
    assert.equal(asset.sha256, createHash("sha256").update(contents).digest("hex"));
});

test("WorkerAssetResolver allows host target to use dev fallback", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const hostTarget = probeLocalWorkerTarget();
    const fallbackPath =
        hostTarget.os === "linux"
            ? join(fixture.root, "src", "worker", "target", hostTarget.rustTarget, "debug", "devshell-worker")
            : join(fixture.root, "src", "worker", "target", "debug", "devshell-worker");
    await writeExecutable(fallbackPath, "#!/bin/sh\necho host\n");

    const asset = await fixture.resolver.resolve(hostTarget);

    assert.equal(asset.binaryPath, fallbackPath);
    assert.equal(asset.source, "dev");
    assert.equal(asset.searchedPaths.includes(fallbackPath), true);
});

test("WorkerAssetResolver does not use host dev fallback for non-host target", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const hostTarget = probeLocalWorkerTarget();
    const nonHostTarget = supportedWorkerTargets.find((target) => target.key !== hostTarget.key);
    assert.notEqual(nonHostTarget, undefined);

    await writeExecutable(join(fixture.root, "src", "worker", "target", "debug", "devshell-worker"), "#!/bin/sh\necho host\n");

    await assert.rejects(fixture.resolver.resolve(nonHostTarget!), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerAssetUnavailable");
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.targetKey, nonHostTarget?.key);
        assert.equal(Array.isArray(details?.searchedPaths), true);
        assert.equal((details?.searchedPaths as string[]).some((entry) => entry.includes("/target/debug/devshell-worker")), false);
        return true;
    });
});

test("WorkerAssetResolver reports searched paths when asset is unavailable", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("darwin-arm64");

    await assert.rejects(fixture.resolver.resolve(target), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerAssetUnavailable");
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.targetKey, "darwin-arm64");
        assert.equal(Array.isArray(details?.searchedPaths), true);
        assert.equal((details?.searchedPaths as string[]).some((entry) => entry.endsWith("/assets/workers/darwin-arm64/devshell-worker")), true);
        return true;
    });
});

async function createResolverFixture(): Promise<{
    root: string;
    resolver: WorkerAssetResolver;
    cleanup: () => Promise<void>;
}> {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-resolver-"));
    const modulePath = join(root, "src", "worker", "WorkerAssetResolver.js");
    await mkdir(dirname(modulePath), { recursive: true });

    return {
        root,
        resolver: new WorkerAssetResolver(pathToFileURL(modulePath).href),
        cleanup: async () => {
            await rm(root, { recursive: true, force: true });
        }
    };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, { mode: 0o755 });
}

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

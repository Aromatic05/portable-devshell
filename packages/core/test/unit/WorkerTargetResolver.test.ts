import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    assert.equal(probeLocalWorkerTarget("local", "resolveExecutable", "win32", "x64").key, "windows-x64");
    assert.equal(probeLocalWorkerTarget("local", "resolveExecutable", "win32", "arm64").key, "windows-arm64");
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
                "darwin-arm64",
                "windows-x64",
                "windows-arm64"
            ]);
            return true;
        }
    );
});

test("WorkerAssetResolver prefers target-specific env var over release lookup", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("darwin-arm64");
    const envPath = join(fixture.root, "env", "devshell-worker");
    await writeExecutable(envPath, "#!/bin/sh\necho env\n");

    process.env.PORTABLE_DEVSHELL_WORKER_DARWIN_ARM64_PATH = envPath;

    const asset = await fixture.resolver.resolve(target);

    assert.equal(asset.binaryPath, envPath);
    assert.equal(asset.source, "env");
    assert.equal(asset.target.key, "darwin-arm64");
    assert.deepEqual(asset.searchedPaths, [envPath]);
});

test("WorkerAssetResolver resolves release asset from configured release base url and reuses cache", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("linux-arm64");
    const contents = "#!/bin/sh\necho package\n";
    const sha256 = createHash("sha256").update(contents).digest("hex");
    const assetName = `devshell-worker-${target.key}`;
    const requestUrls: string[] = [];
    const releaseBaseUrl = "https://example.test/releases/download";
    process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL = releaseBaseUrl;
    process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_TAG = "v9.9.9";
    process.env.PORTABLE_DEVSHELL_WORKER_CACHE_DIR = join(fixture.root, "cache");

    globalThis.fetch = async (input) => {
        const url = String(input);
        requestUrls.push(url);

        if (url === `${releaseBaseUrl}/v9.9.9/${assetName}.sha256`) {
            return new Response(`${sha256}\n`, {
                headers: { "content-type": "text/plain" },
                status: 200
            });
        }

        if (url === `${releaseBaseUrl}/v9.9.9/${assetName}`) {
            return new Response(contents, {
                headers: { "content-type": "application/octet-stream" },
                status: 200
            });
        }

        return new Response("missing", { status: 404 });
    };

    const asset = await fixture.resolver.resolve(target);
    const cachedContents = await readFile(asset.binaryPath, "utf8");
    globalThis.fetch = async (input) => {
        const url = String(input);
        requestUrls.push(url);
        if (url === `${releaseBaseUrl}/v9.9.9/${assetName}.sha256`) {
            return new Response(`${sha256}\n`, {
                headers: { "content-type": "text/plain" },
                status: 200
            });
        }

        throw new Error("cached release asset should not redownload binary");
    };
    const cachedAsset = await fixture.resolver.resolve(target);

    assert.equal(asset.source, "release");
    assert.equal(asset.sha256, sha256);
    assert.equal(cachedContents, contents);
    assert.equal(cachedAsset.source, "release");
    assert.equal(cachedAsset.binaryPath, asset.binaryPath);
    assert.deepEqual(requestUrls, [
        `${releaseBaseUrl}/v9.9.9/${assetName}.sha256`,
        `${releaseBaseUrl}/v9.9.9/${assetName}`,
        `${releaseBaseUrl}/v9.9.9/${assetName}.sha256`
    ]);
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
    process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_TAG = "v0.2.2";

    await writeExecutable(join(fixture.root, "src", "worker", "target", "debug", "devshell-worker"), "#!/bin/sh\necho host\n");
    globalThis.fetch = async () => new Response("missing", { status: 404 });

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

test("WorkerAssetResolver uses the default release repository when release env is unset", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = getWorkerTargetByKey("darwin-arm64");
    process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_TAG = "v1.2.3";
    delete process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY;
    delete process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL;

    globalThis.fetch = async () => new Response("missing", { status: 404 });

    await assert.rejects(fixture.resolver.resolve(target), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerAssetUnavailable");
        const details = (error as { details?: Record<string, unknown> }).details;
        assert.equal(details?.targetKey, "darwin-arm64");
        assert.equal(Array.isArray(details?.searchedPaths), true);
        assert.equal(
            (details?.searchedPaths as string[]).some(
                (entry) => entry === "https://github.com/Aromatic05/portable-devshell/releases/download/v1.2.3/devshell-worker-darwin-arm64.sha256"
            ),
            true
        );
        return true;
    });
});

async function createResolverFixture(): Promise<{
    root: string;
    devshellHome: string;
    resolver: WorkerAssetResolver;
    cleanup: () => Promise<void>;
}> {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-resolver-"));
    const devshellHome = join(root, "devshell-home");
    const modulePath = join(root, "src", "worker", "WorkerAssetResolver.js");
    const previousFetch = globalThis.fetch;
    const environmentNames = [
        "PORTABLE_DEVSHELL_HOME",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_TAG",
        "PORTABLE_DEVSHELL_WORKER_CACHE_DIR",
        ...supportedWorkerTargets.map((target) => `PORTABLE_DEVSHELL_WORKER_${target.key.replaceAll("-", "_").toUpperCase()}_PATH`)
    ] as const;
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));

    for (const name of environmentNames) {
        delete process.env[name];
    }
    process.env.PORTABLE_DEVSHELL_HOME = devshellHome;

    await mkdir(dirname(modulePath), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "portable-devshell", version: "0.2.2" }), "utf8");

    return {
        root,
        devshellHome,
        resolver: new WorkerAssetResolver(pathToFileURL(modulePath).href),
        cleanup: async () => {
            globalThis.fetch = previousFetch;
            for (const [name, value] of previousEnvironment) {
                restoreEnv(name, value);
            }
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

test("WorkerAssetResolver uses an installed target worker before release lookup", async (t) => {
    const fixture = await createResolverFixture();
    t.after(fixture.cleanup);

    const target = supportedWorkerTargets.find((candidate) => candidate.key !== probeLocalWorkerTarget().key) ?? probeLocalWorkerTarget();
    const installedPath = join(fixture.devshellHome, "bin", `devshell-worker-${target.key}`);
    await writeExecutable(installedPath, "#!/bin/sh\necho installed\n");

    globalThis.fetch = async () => {
        throw new Error("release lookup should not run for an installed worker");
    };

    const asset = await fixture.resolver.resolve(target);

    assert.equal(asset.binaryPath, installedPath);
    assert.equal(asset.source, "installed");
});

test("WorkerAssetResolver derives the release tag from an installed app manifest", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-installed-resolver-"));
    const appRoot = join(root, "app");
    const modulePath = join(
        appRoot,
        "node_modules",
        ".pnpm",
        "@portable-devshell+core@file+fixture",
        "node_modules",
        "@portable-devshell",
        "core",
        "dist",
        "worker",
        "WorkerAssetResolver.js"
    );
    const environmentNames = [
        "PORTABLE_DEVSHELL_HOME",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_REPOSITORY",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL",
        "PORTABLE_DEVSHELL_WORKER_RELEASE_TAG",
        "PORTABLE_DEVSHELL_WORKER_CACHE_DIR"
    ] as const;
    const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
    const previousFetch = globalThis.fetch;
    const requestUrls: string[] = [];

    t.after(async () => {
        globalThis.fetch = previousFetch;
        for (const [name, value] of previousEnvironment) {
            restoreEnv(name, value);
        }
        await rm(root, { recursive: true, force: true });
    });

    for (const name of environmentNames) {
        delete process.env[name];
    }
    process.env.PORTABLE_DEVSHELL_HOME = join(root, "devshell-home");
    process.env.PORTABLE_DEVSHELL_WORKER_RELEASE_BASE_URL = "https://example.test/releases/download";
    process.env.PORTABLE_DEVSHELL_WORKER_CACHE_DIR = join(root, "cache");

    await mkdir(dirname(modulePath), { recursive: true });
    await writeFile(join(appRoot, "portable-devshell-install.json"), JSON.stringify({ version: "7.8.9" }), "utf8");

    globalThis.fetch = async (input) => {
        requestUrls.push(String(input));
        return new Response("missing", { status: 404 });
    };

    const target = getWorkerTargetByKey("darwin-arm64");
    const resolver = new WorkerAssetResolver(pathToFileURL(modulePath).href);

    await assert.rejects(resolver.resolve(target), (error: unknown) => {
        assert.ok(typeof error === "object" && error !== null);
        assert.equal((error as { code?: string }).code, "core.workerAssetUnavailable");
        return true;
    });
    assert.equal(
        requestUrls[0],
        "https://example.test/releases/download/v7.8.9/devshell-worker-darwin-arm64.sha256"
    );
});
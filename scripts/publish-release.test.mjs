import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../test/TestTempDirectory.mjs";
import {
    assertReleaseAbsent,
    expectedReleaseAssetNames,
    publishRelease,
    verifyReleaseAssets,
} from "./publish-release.mjs";

test("release preflight permits a missing tag and rejects an already published tag", async () => {
    const requests = [];
    await assertReleaseAbsent({
        repository: "owner/project",
        tag: "v1.2.3",
        token: "test-token",
        async fetchImpl(url, options) {
            requests.push({ options, url });
            return { ok: false, status: 404 };
        },
    });
    assert.equal(requests.length, 1);
    assert.match(
        requests[0].url,
        /\/owner\/project\/releases\/tags\/v1\.2\.3$/u,
    );
    assert.equal(
        requests[0].options.headers.Authorization,
        "Bearer test-token",
    );

    await assert.rejects(
        assertReleaseAbsent({
            repository: "owner/project",
            tag: "v1.2.3",
            token: "test-token",
            async fetchImpl() {
                return { ok: true, status: 200 };
            },
        }),
        /already exists; rebuilding published assets is forbidden/u,
    );
});

test("release preflight fails closed when GitHub cannot determine tag publication state", async () => {
    await assert.rejects(
        assertReleaseAbsent({
            repository: "owner/project",
            tag: "v1.2.3",
            token: "test-token",
            async fetchImpl() {
                return { ok: false, status: 503 };
            },
        }),
        /lookup failed for v1\.2\.3 with HTTP 503/u,
    );
});

async function createReleaseAssets() {
    const root = await createTestTempDirectory("publish-release");
    const directory = resolve(root, "assets");
    await mkdir(directory, { recursive: true });
    for (const name of expectedReleaseAssetNames().filter(
        (candidate) => !candidate.endsWith(".sha256"),
    )) {
        const content = Buffer.from(`release asset ${name}\n`, "utf8");
        await writeFile(resolve(directory, name), content);
        const sha256 = createHash("sha256").update(content).digest("hex");
        await writeFile(
            resolve(directory, `${name}.sha256`),
            `${sha256}  ${name}\n`,
            "utf8",
        );
    }
    return { directory, root };
}

test("release asset validation requires every native application, worker, installer, and checksum", async () => {
    const fixture = await createReleaseAssets();
    try {
        const assets = await verifyReleaseAssets(fixture.directory);
        assert.deepEqual(
            assets.map((path) => basename(path)).sort(),
            expectedReleaseAssetNames(),
        );
        await rm(
            resolve(fixture.directory, "devshell-worker-darwin-arm64.sha256"),
        );
        await assert.rejects(
            verifyReleaseAssets(fixture.directory),
            /release asset is missing: devshell-worker-darwin-arm64\.sha256/u,
        );
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

test("release asset validation rejects bytes that do not match the published checksum", async () => {
    const fixture = await createReleaseAssets();
    try {
        const asset = resolve(
            fixture.directory,
            "portable-devshell-app-linux-x64.tar.gz",
        );
        await writeFile(
            asset,
            `${await readFile(asset, "utf8")}corrupted`,
            "utf8",
        );
        await assert.rejects(
            verifyReleaseAssets(fixture.directory),
            /release checksum mismatch for portable-devshell-app-linux-x64\.tar\.gz/u,
        );
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

test("publishing creates one immutable release and has no upload or clobber fallback", async () => {
    const fixture = await createReleaseAssets();
    const calls = [];
    try {
        await publishRelease({
            assetDirectory: fixture.directory,
            tag: "v1.2.3",
            runCommand(command, args) {
                calls.push({ args, command });
                return { status: 0, stderr: "", stdout: "" };
            },
        });
        assert.equal(calls.length, 1);
        assert.equal(calls[0].command, "gh");
        assert.deepEqual(calls[0].args.slice(0, 3), [
            "release",
            "create",
            "v1.2.3",
        ]);
        assert.equal(calls[0].args.includes("upload"), false);
        assert.equal(calls[0].args.includes("--clobber"), false);
        assert.equal(calls[0].args.includes("--verify-tag"), true);
        for (const name of expectedReleaseAssetNames()) {
            assert.equal(
                calls[0].args.some((value) => basename(value) === name),
                true,
            );
        }
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

test("an existing release or any other gh failure stops publishing without a mutation fallback", async () => {
    const fixture = await createReleaseAssets();
    let calls = 0;
    try {
        await assert.rejects(
            publishRelease({
                assetDirectory: fixture.directory,
                tag: "v1.2.3",
                runCommand() {
                    calls += 1;
                    return {
                        status: 1,
                        stderr: "release already exists",
                        stdout: "",
                    };
                },
            }),
            /GitHub Release creation failed for v1\.2\.3/u,
        );
        assert.equal(calls, 1);
    } finally {
        await rm(fixture.root, { force: true, recursive: true });
    }
});

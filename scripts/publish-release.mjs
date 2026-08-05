import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TARGETS = [
    "linux-x64",
    "linux-arm64",
    "darwin-x64",
    "darwin-arm64",
    "windows-x64",
    "windows-arm64",
];

export function expectedReleaseAssetNames() {
    const assets = [];
    for (const target of TARGETS) {
        const application = `portable-devshell-app-${target}.tar.gz`;
        const worker = target.startsWith("windows-")
            ? `devshell-worker-${target}.exe`
            : `devshell-worker-${target}`;
        assets.push(
            application,
            `${application}.sha256`,
            worker,
            `${worker}.sha256`,
        );
    }
    assets.push(
        "install-release.sh",
        "install-release.sh.sha256",
        "install-release.ps1",
        "install-release.ps1.sha256",
    );
    return assets.sort();
}

export async function verifyReleaseAssets(assetDirectory) {
    const directory = resolve(assetDirectory);
    const names = expectedReleaseAssetNames();
    for (const name of names) {
        const path = resolve(directory, name);
        const metadata = await stat(path).catch((error) => {
            throw new Error(`release asset is missing: ${name}`, {
                cause: error,
            });
        });
        if (!metadata.isFile()) {
            throw new Error(`release asset is not a regular file: ${name}`);
        }
    }

    for (const checksumName of names.filter((name) =>
        name.endsWith(".sha256"),
    )) {
        const assetName = checksumName.slice(0, -".sha256".length);
        const expected = readChecksum(
            await readFile(resolve(directory, checksumName), "utf8"),
            checksumName,
        );
        const actual = createHash("sha256")
            .update(await readFile(resolve(directory, assetName)))
            .digest("hex");
        if (actual !== expected) {
            throw new Error(
                `release checksum mismatch for ${assetName}: expected ${expected}, received ${actual}`,
            );
        }
    }

    return names.map((name) => resolve(directory, name));
}

export async function assertReleaseAbsent({
    repository,
    tag,
    token,
    fetchImpl = fetch,
}) {
    if (
        typeof repository !== "string" ||
        !/^[^/\s]+\/[^/\s]+$/u.test(repository)
    ) {
        throw new Error(`invalid release repository: ${String(repository)}`);
    }
    assertReleaseTag(tag);
    if (typeof token !== "string" || token.length === 0) {
        throw new Error(
            "GitHub token is required to check release immutability",
        );
    }
    const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
        {
            headers: {
                Accept: "application/vnd.github+json",
                Authorization: `Bearer ${token}`,
                "User-Agent": "portable-devshell-release",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        },
    );
    if (response.status === 404) return;
    if (response.ok) {
        throw new Error(
            `GitHub Release ${tag} already exists; rebuilding published assets is forbidden`,
        );
    }
    throw new Error(
        `GitHub Release lookup failed for ${tag} with HTTP ${response.status}`,
    );
}

export async function publishRelease({
    assetDirectory,
    tag,
    runCommand = runCommandSync,
}) {
    assertReleaseTag(tag);
    const assets = await verifyReleaseAssets(assetDirectory);
    const args = [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--generate-notes",
        "--title",
        tag,
        ...assets,
    ];
    const result = runCommand("gh", args);
    if (result.error !== undefined || result.status !== 0) {
        throw new Error(
            `GitHub Release creation failed for ${tag} (${result.status ?? "unknown"})\n${result.error?.stack ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
        );
    }
}

function readChecksum(content, name) {
    const value = content.trim().split(/\s+/u)[0]?.toLowerCase();
    if (value === undefined || !/^[0-9a-f]{64}$/u.test(value)) {
        throw new Error(`release checksum file is invalid: ${name}`);
    }
    return value;
}

function assertReleaseTag(tag) {
    if (
        typeof tag !== "string" ||
        !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag)
    ) {
        throw new Error(`invalid release tag: ${String(tag)}`);
    }
}

function runCommandSync(command, args) {
    return spawnSync(command, args, {
        encoding: "utf8",
        env: process.env,
    });
}

const invokedPath =
    process.argv[1] === undefined ? undefined : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const tag = readOption(args, "--tag") ?? process.env.GITHUB_REF_NAME;
    if (args.includes("--check-absent")) {
        await assertReleaseAbsent({
            repository:
                readOption(args, "--repository") ??
                process.env.GITHUB_REPOSITORY,
            tag,
            token: process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
        });
    } else {
        const assetDirectory =
            readOption(args, "--asset-dir") ?? "./release-assets";
        await publishRelease({ assetDirectory, tag });
    }
}

function readOption(args, name) {
    const index = args.indexOf(name);
    if (index < 0) return undefined;
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
        throw new Error(`${name} requires a value`);
    }
    return value;
}

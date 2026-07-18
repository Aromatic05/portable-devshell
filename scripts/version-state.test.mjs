import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./version-state.mjs", import.meta.url));

async function createRepository(version, releaseTag) {
    const root = await mkdtemp(join(tmpdir(), "portable-devshell-version-"));
    await mkdir(join(root, "crates/devshell-worker"), { recursive: true });
    await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "portable-devshell", version }, null, 4)}\n`);
    await writeFile(join(root, "crates/devshell-worker/Cargo.toml"), `[package]\nname = "devshell-worker"\nversion = "${version}"\nedition = "2024"\n`);
    await writeFile(join(root, "Cargo.lock"), `[[package]]\nname = "devshell-worker"\nversion = "${version}"\n`);
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "version-test@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Version Test"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: root });
    if (releaseTag !== undefined) execFileSync("git", ["tag", releaseTag], { cwd: root });
    return root;
}

function run(root, ...args) {
    return spawnSync(process.execPath, [script, ...args, "--root", root], {
        encoding: "utf8"
    });
}

test("development version must be newer than the latest release tag", async () => {
    const root = await createRepository("0.4.2", "v0.4.1");
    try {
        assert.equal(run(root, "check-development").status, 0);
        const stale = await createRepository("0.4.1", "v0.4.1");
        try {
            const result = run(stale, "check-development");
            assert.equal(result.status, 1);
            assert.match(result.stderr, /must be greater than latest release/u);
        } finally {
            await rm(stale, { force: true, recursive: true });
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("set keeps app and worker versions synchronized", async () => {
    const root = await createRepository("0.4.2", "v0.4.1");
    try {
        assert.equal(run(root, "set", "0.4.3").status, 0);
        assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.4.3");
        assert.match(await readFile(join(root, "crates/devshell-worker/Cargo.toml"), "utf8"), /version = "0\.4\.3"/u);
        assert.match(await readFile(join(root, "Cargo.lock"), "utf8"), /version = "0\.4\.3"/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("version checks accept a CRLF Cargo lockfile", async () => {
    const root = await createRepository("0.4.2", "v0.4.1");
    try {
        const lockPath = join(root, "Cargo.lock");
        await writeFile(lockPath, (await readFile(lockPath, "utf8")).replaceAll("\n", "\r\n"), "utf8");
        assert.equal(run(root, "check-development").status, 0);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("release check requires an exact tag and post-release advance bumps one patch", async () => {
    const root = await createRepository("0.4.2", "v0.4.1");
    try {
        assert.equal(run(root, "check-release", "v0.4.2").status, 0);
        assert.equal(run(root, "check-release", "v0.4.3").status, 1);
        assert.equal(run(root, "advance-after-release", "v0.4.2").status, 0);
        assert.equal(JSON.parse(await readFile(resolve(root, "package.json"), "utf8")).version, "0.4.3");
        assert.match(run(root, "advance-after-release", "v0.4.2").stdout, /already advanced 0\.4\.3/u);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

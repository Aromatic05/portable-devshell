import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    assertPackageBinFile,
    normalizeCliArguments,
    readPackageBinPath,
    resolvePackageBinPath,
    writePortableApplicationManifest
} from "./application-layout.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

test("CLI argument normalization removes only the pnpm separator", () => {
    assert.deepEqual(normalizeCliArguments(["--", "status"]), ["status"]);
    assert.deepEqual(normalizeCliArguments(["status"]), ["status"]);
    assert.deepEqual(normalizeCliArguments(["instance", "status", "alpha"]), ["instance", "status", "alpha"]);
    assert.deepEqual(normalizeCliArguments([]), []);
});

test("package bin resolver reads the declared devshell entry instead of assuming a build directory", async () => {
    const packageRoot = resolve(repositoryRoot, "packages", "cli");
    const cli = await readPackageBinPath(packageRoot, "devshell");

    assert.equal(cli.relativePath, "dist/CliMain.js");
    assert.equal(cli.absolutePath, resolve(packageRoot, "dist", "CliMain.js"));
    assert.equal(cli.command, "devshell");
});

test("package bin resolver accepts object and string bin declarations", () => {
    assert.deepEqual(
        resolvePackageBinPath("/app", {
            name: "@portable-devshell/cli",
            bin: { devshell: "./dist/CliMain.js" }
        }, "devshell"),
        {
            absolutePath: resolve("/app", "dist", "CliMain.js"),
            command: "devshell",
            relativePath: "dist/CliMain.js"
        }
    );

    assert.deepEqual(
        resolvePackageBinPath("/app", {
            name: "@portable-devshell/cli",
            bin: "dist/CliMain.js"
        }, "cli"),
        {
            absolutePath: resolve("/app", "dist", "CliMain.js"),
            command: "cli",
            relativePath: "dist/CliMain.js"
        }
    );
});

test("package bin resolver rejects missing, absolute, and escaping entries", () => {
    assert.throws(
        () => resolvePackageBinPath("/app", { name: "cli" }, "devshell"),
        /does not declare bin\.devshell/u
    );
    assert.throws(
        () => resolvePackageBinPath("/app", { name: "cli", bin: { devshell: "/tmp/cli.js" } }, "devshell"),
        /must be relative/u
    );
    assert.throws(
        () => resolvePackageBinPath("/app", { name: "cli", bin: { devshell: "../cli.js" } }, "devshell"),
        /escapes package root/u
    );
    assert.throws(
        () => resolvePackageBinPath("/app", { name: "cli", bin: { devshell: "" } }, "devshell"),
        /non-empty string/u
    );
});

test("package bin file assertion accepts a regular file and rejects directories and symlinks", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-layout-test-"));
    try {
        await mkdir(resolve(root, "dist"), { recursive: true });
        await writeFile(resolve(root, "dist", "CliMain.js"), "#!/usr/bin/env node\n", "utf8");
        await assertPackageBinFile({
            absolutePath: resolve(root, "dist", "CliMain.js"),
            command: "devshell",
            relativePath: "dist/CliMain.js"
        });

        await assert.rejects(
            () => assertPackageBinFile({
                absolutePath: resolve(root, "dist"),
                command: "devshell",
                relativePath: "dist"
            }),
            /not a regular file/u
        );

        await symlink(resolve(root, "dist", "CliMain.js"), resolve(root, "dist", "linked.js"));
        await assert.rejects(
            () => assertPackageBinFile({
                absolutePath: resolve(root, "dist", "linked.js"),
                command: "devshell",
                relativePath: "dist/linked.js"
            }),
            /must not be a symbolic link/u
        );
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("portable application manifest removes workspace paths and publishes the release version", async () => {
    const root = await mkdtemp(resolve(tmpdir(), "portable-devshell-manifest-test-"));
    try {
        await mkdir(resolve(root, "dist"), { recursive: true });
        await writeFile(resolve(root, "dist", "CliMain.js"), "#!/usr/bin/env node\n", "utf8");
        await writeFile(resolve(root, "package.json"), JSON.stringify({
            name: "@portable-devshell/cli",
            version: "0.0.0",
            type: "module",
            bin: { devshell: "./dist/CliMain.js" },
            dependencies: {
                "@portable-devshell/control": "@portable-devshell/control@file:///build/portable-devshell/packages/control"
            }
        }), "utf8");

        const manifest = await writePortableApplicationManifest(root, {
            minimumNodeMajor: 24,
            version: "0.4.4"
        });
        assert.deepEqual(manifest, {
            name: "portable-devshell",
            version: "0.4.4",
            private: true,
            type: "module",
            bin: { devshell: "./dist/CliMain.js" },
            engines: { node: ">=24" }
        });
        const source = await readFile(resolve(root, "package.json"), "utf8");
        assert.equal(source.includes("file://"), false);
        assert.equal(source.includes("0.0.0"), false);
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("release and installation scripts share the manifest-derived application layout", async () => {
    const files = [
        "scripts/package-app.mjs",
        "scripts/smoke-package.mjs",
        "scripts/install-local.mjs",
        "scripts/smoke-client.mjs",
        "scripts/dev.mjs"
    ];

    for (const file of files) {
        const source = await readFile(resolve(repositoryRoot, file), "utf8");
        assert.match(source, /application-layout\.mjs/u, `${file} must use the shared layout resolver`);
        assert.doesNotMatch(source, /dist["'],\s*["']cli["'],\s*["']CliMain\.js/u, `${file} contains the legacy CLI path`);
        assert.doesNotMatch(source, /dist\/cli\/CliMain\.js/u, `${file} contains the legacy CLI path`);
    }


    for (const file of ["scripts/install-release.sh", "scripts/install-release.ps1"]) {
        const source = await readFile(resolve(repositoryRoot, file), "utf8");
        assert.doesNotMatch(source, /dist[\\/]cli[\\/]CliMain\.js/u, `${file} contains the legacy CLI path`);
        assert.match(source, /package\.json/u, `${file} must inspect the installed package manifest`);
        assert.match(source, /bin(?:\.devshell|\["devshell"\])/u, `${file} must resolve bin.devshell`);
    }

    const windowsWorkflow = await readFile(resolve(repositoryRoot, ".github", "workflows", "windows.yml"), "utf8");
    assert.doesNotMatch(windowsWorkflow, /packages\/cli\/dist\/cli\/CliMain\.js/u);
    assert.match(windowsWorkflow, /packages\/cli\/dist\/CliMain\.js/u);

    for (const workflow of ["ci.yml", "release.yml"]) {
        const source = await readFile(resolve(repositoryRoot, ".github", "workflows", workflow), "utf8");
        assert.match(source, /pnpm smoke:package/u, `${workflow} must execute the packaged application smoke`);
    }
    assert.match(windowsWorkflow, /pnpm test:release-layout/u, "Windows CI must validate release layout contracts");
});

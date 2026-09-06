import assert from "node:assert/strict";
import { link, lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import {
    assertPackageBinFile,
    materializeApplicationTree,
    normalizeCliArguments,
    readPackageBinPath,
    resolvePackageBinPath,
    writePortableApplicationManifest
} from "./application-layout.mjs";
import {
    cleanupTestTempDirectories,
    createTestTempDirectory,
    resolveTestTempNamespace
} from "../test/TestTempDirectory.mjs";


test("test temp cleanup preserves the shared namespace for concurrent test processes", async () => {
    const namespace = await resolveTestTempNamespace();
    cleanupTestTempDirectories();
    assert.equal(await realpath(namespace), namespace);
});

test("CLI argument normalization removes only the pnpm separator", () => {
    assert.deepEqual(normalizeCliArguments(["--", "status"]), ["status"]);
    assert.deepEqual(normalizeCliArguments(["status"]), ["status"]);
    assert.deepEqual(normalizeCliArguments(["instance", "status", "alpha"]), ["instance", "status", "alpha"]);
    assert.deepEqual(normalizeCliArguments([]), []);
});

test("application materialization breaks deploy hardlinks and dereferences symlinks", async () => {
    const root = await createTestTempDirectory("materialize-app-test");
    try {
        const external = resolve(root, "workspace-dist.js");
        const deploy = resolve(root, "deploy");
        const target = resolve(root, "target");
        await mkdir(resolve(deploy, "node_modules", "pkg"), { recursive: true });
        await writeFile(external, "original\n", "utf8");
        const deployed = resolve(deploy, "node_modules", "pkg", "index.js");
        await link(external, deployed);
        if (process.platform !== "win32") {
            await symlink("index.js", resolve(deploy, "node_modules", "pkg", "alias.js"));
        }

        await materializeApplicationTree(deploy, target);
        const materialized = resolve(target, "node_modules", "pkg", "index.js");
        await writeFile(external, "mutated\n", "utf8");

        assert.equal(await readFile(materialized, "utf8"), "original\n");
        if (process.platform !== "win32") {
            const alias = resolve(target, "node_modules", "pkg", "alias.js");
            assert.equal((await lstat(alias)).isSymbolicLink(), false);
            assert.equal(await readFile(alias, "utf8"), "original\n");
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
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
    const root = await createTestTempDirectory("layout-test");
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

        if (process.platform !== "win32") {
            await symlink(resolve(root, "dist", "CliMain.js"), resolve(root, "dist", "linked.js"));
            await assert.rejects(
                () => assertPackageBinFile({
                    absolutePath: resolve(root, "dist", "linked.js"),
                    command: "devshell",
                    relativePath: "dist/linked.js"
                }),
                /must not be a symbolic link/u
            );
        }
    } finally {
        await rm(root, { force: true, recursive: true });
    }
});

test("portable application manifest removes workspace paths and publishes the release version", async () => {
    const root = await createTestTempDirectory("manifest-test");
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

import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    assertNoSymbolicLinks,
    assertThinAgentExtensionTree,
    pruneProviderRuntimeTree,
    resolveAgentPackageSelection,
    sanitizeDeployTree,
    shapeThinAgentExtensionTree
} from "./package-agent.mjs";

const repoRoot = new URL("../", import.meta.url);

test("Agent packaging can emit both artifacts or one release-matrix half", () => {
    assert.deepEqual(resolveAgentPackageSelection([]), {
        includeExtension: true,
        includeProvider: true
    });
    assert.deepEqual(resolveAgentPackageSelection(["--provider-only"]), {
        includeExtension: false,
        includeProvider: true
    });
    assert.deepEqual(resolveAgentPackageSelection(["--extension-only"]), {
        includeExtension: true,
        includeProvider: false
    });
    assert.throws(
        () => resolveAgentPackageSelection(["--provider-only", "--extension-only"]),
        /mutually exclusive/u
    );
});

test("Agent Extension source package owns the Pi provider without separate Agent workspace packages", async () => {
    const agentExtension = JSON.parse(await readFile(new URL("extensions/agent/package.json", repoRoot), "utf8"));
    assert.equal(agentExtension.dependencies.diff, "9.0.0");
    await assert.rejects(readFile(new URL("packages/agentd/package.json", repoRoot), "utf8"));
    await assert.rejects(readFile(new URL("packages/agent-provider-pi/package.json", repoRoot), "utf8"));
    await assert.rejects(readFile(new URL("packages/pi-extension/package.json", repoRoot), "utf8"));
});

test("thin Agent Extension payload guard rejects private node_modules", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-thin-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "node_modules", "@portable-devshell", "extension"), { recursive: true });
    await assert.rejects(
        () => assertThinAgentExtensionTree(root),
        /must not contain private node_modules/u
    );
});

test("thin Agent Extension shaping removes the internal Pi subtree and provider dependencies", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-shape-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "dist", "provider", "pi"), { recursive: true });
    await writeFile(join(root, "dist", "provider", "pi", "index.js"), "export {};\n", "utf8");
    await mkdir(join(root, "dist", "builtin"), { recursive: true });
    await writeFile(join(root, "dist", "builtin", "devshell-extension.json"), JSON.stringify({
        apiVersion: 2,
        capabilities: ["command"],
        entry: "index.js",
        id: "agent",
        name: "portable-devshell Agent",
        schemaVersion: 1,
        version: "0.1.3"
    }), "utf8");
    await mkdir(join(root, "node_modules", "@portable-devshell", "extension"), { recursive: true });
    await mkdir(join(root, "node_modules", "@portable-devshell", "shared"), { recursive: true });
    await mkdir(join(root, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "source", type: "module", version: "9.9.9" }), "utf8");

    await shapeThinAgentExtensionTree(root);
    await assertThinAgentExtensionTree(root);
    await assert.rejects(() => lstat(join(root, "node_modules")), /ENOENT/u);
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    assert.equal(manifest.name, "@portable-devshell/agent-extension");
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@portable-devshell/extension"]);
    const extensionManifest = JSON.parse(await readFile(join(root, "devshell-extension.json"), "utf8"));
    assert.equal(extensionManifest.entry, "dist/builtin/index.js");
});

test("Agent artifact sanitizer removes pnpm deployment metadata and symlink guard remains strict", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-sanitize-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(root, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(join(root, "node_modules", ".modules.yaml"), "x", "utf8");
    await writeFile(join(root, "pnpm-lock.yaml"), "x", "utf8");
    await writeFile(join(root, "plain"), "x", "utf8");
    const nestedBin = join(root, "node_modules", "esbuild", "node_modules", ".bin");
    await mkdir(nestedBin, { recursive: true });
    await symlink(join(root, "plain"), join(nestedBin, "esbuild"));
    await sanitizeDeployTree(root);
    await assert.rejects(readFile(join(root, "pnpm-lock.yaml"), "utf8"));
    await assert.rejects(() => lstat(nestedBin), /ENOENT/u);

    await symlink(join(root, "plain"), join(root, "link"));
    await assert.rejects(() => assertNoSymbolicLinks(root), /symbolic link/u);
});

test("Pi provider runtime pruning removes type, map, and test payloads while preserving executable sources", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-provider-prune-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const pkg = join(root, "node_modules", "plugin");
    await mkdir(join(pkg, "tests"), { recursive: true });
    await writeFile(join(pkg, "index.js"), "export {};\n", "utf8");
    await writeFile(join(pkg, "extension.ts"), "export {};\n", "utf8");
    await writeFile(join(pkg, "index.d.ts"), "export {};\n", "utf8");
    await writeFile(join(pkg, "index.js.map"), "{}\n", "utf8");
    await writeFile(join(pkg, "tests", "fixture.js"), "export {};\n", "utf8");

    await pruneProviderRuntimeTree(root);

    assert.equal((await readFile(join(pkg, "index.js"), "utf8")).length > 0, true);
    assert.equal((await readFile(join(pkg, "extension.ts"), "utf8")).length > 0, true);
    await assert.rejects(() => lstat(join(pkg, "index.d.ts")), /ENOENT/u);
    await assert.rejects(() => lstat(join(pkg, "index.js.map")), /ENOENT/u);
    await assert.rejects(() => lstat(join(pkg, "tests")), /ENOENT/u);
});

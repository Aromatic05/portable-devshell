import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    assertNoSymbolicLinks,
    assertThinAgentExtensionTree,
    sanitizeDeployTree,
    shapePiProviderTree,
    shapeThinAgentExtensionTree
} from "./package-agent.mjs";

const repoRoot = new URL("../", import.meta.url);

test("Agent Extension source package owns the Pi provider without separate Agent workspace packages", async () => {
    const agentExtension = JSON.parse(await readFile(new URL("extensions/agent/package.json", repoRoot), "utf8"));
    assert.equal(agentExtension.dependencies["@earendil-works/pi-coding-agent"], "0.84.4");
    assert.equal(agentExtension.dependencies["@earendil-works/pi-tui"], "0.84.4");
    assert.equal(agentExtension.dependencies.diff, "8.0.4");
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
        version: "0.1.2"
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
    assert.equal(manifest.version, "0.1.2");
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["@portable-devshell/extension"]);
    const extensionManifest = JSON.parse(await readFile(join(root, "devshell-extension.json"), "utf8"));
    assert.equal(extensionManifest.entry, "dist/builtin/index.js");
});

test("Pi provider deployment keeps the provider manifest version independent from Agent Extension", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-provider-shape-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "dist", "provider", "pi"), { recursive: true });
    await writeFile(join(root, "dist", "provider", "pi", "index.js"), "export {};\n", "utf8");
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "source", type: "module", version: "9.9.9" }), "utf8");

    await shapePiProviderTree(root);

    const deployment = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const provider = JSON.parse(await readFile(join(root, "devshell-agent-provider.json"), "utf8"));
    assert.equal(provider.version, "0.1.1");
    assert.equal(deployment.version, provider.version);
});

test("Agent artifact sanitizer removes pnpm deployment metadata and symlink guard remains strict", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-sanitize-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "node_modules", ".bin"), { recursive: true });
    await mkdir(join(root, "node_modules", ".pnpm"), { recursive: true });
    await writeFile(join(root, "node_modules", ".modules.yaml"), "x", "utf8");
    await writeFile(join(root, "pnpm-lock.yaml"), "x", "utf8");
    await sanitizeDeployTree(root);
    await assert.rejects(readFile(join(root, "pnpm-lock.yaml"), "utf8"));

    await writeFile(join(root, "plain"), "x", "utf8");
    await symlink(join(root, "plain"), join(root, "link"));
    await assert.rejects(() => assertNoSymbolicLinks(root), /symbolic link/u);
});

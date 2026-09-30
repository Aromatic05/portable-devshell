import assert from "node:assert/strict";
import {
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    assertNoSymbolicLinks,
    assertThinAgentExtensionTree,
    sanitizeDeployTree,
    shapeThinAgentExtensionTree,
} from "./package-agent.mjs";

const repoRoot = new URL("../", import.meta.url);

test("Agent Extension source package owns provider adapters without separate Agent workspace packages", async () => {
    const agentExtension = JSON.parse(
        await readFile(
            new URL("extensions/agent/package.json", repoRoot),
            "utf8",
        ),
    );
    assert.equal(agentExtension.private, true);
    assert.equal(agentExtension.publishConfig, undefined);
    assert.equal(agentExtension.devDependencies.diff, "9.0.0");
    assert.equal(agentExtension.dependencies, undefined);
    await assert.rejects(
        readFile(new URL("packages/agentd/package.json", repoRoot), "utf8"),
    );
    await assert.rejects(
        readFile(
            new URL("packages/agent-provider-pi/package.json", repoRoot),
            "utf8",
        ),
    );
    await assert.rejects(
        readFile(
            new URL("packages/pi-extension/package.json", repoRoot),
            "utf8",
        ),
    );
});

test("thin Agent Extension payload guard rejects private node_modules and bundled Provider artifacts", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-thin-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "node_modules", "@portable-devshell", "extension"), {
        recursive: true,
    });
    await assert.rejects(
        () => assertThinAgentExtensionTree(root),
        /must not contain private node_modules/u,
    );
    await rm(join(root, "node_modules"), { force: true, recursive: true });
    await mkdir(join(root, "bundled-providers"), { recursive: true });
    await writeFile(
        join(root, "bundled-providers", "legacy-provider.bundle"),
        "legacy\n",
        "utf8",
    );
    await assert.rejects(
        () => assertThinAgentExtensionTree(root),
        /must not contain bundled Provider artifacts/u,
    );
    await rm(join(root, "bundled-providers"), { force: true, recursive: true });
    await mkdir(join(root, "test"), { recursive: true });
    await assert.rejects(
        () => assertThinAgentExtensionTree(root),
        /must not contain source or test trees/u,
    );
});

test("thin Agent Extension shaping keeps provider adapter code and removes deployment dependencies", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-shape-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "dist", "provider", "pi"), { recursive: true });
    await writeFile(
        join(root, "dist", "provider", "pi", "index.js"),
        "export {};\n",
        "utf8",
    );
    await writeFile(
        join(root, "devshell-extension.json"),
        JSON.stringify({
            apiVersion: 2,
            capabilities: ["command"],
            entry: "dist/builtin/index.js",
            id: "agent",
            name: "portable-devshell Agent",
            schemaVersion: 1,
            version: "0.1.3",
        }),
        "utf8",
    );
    await mkdir(join(root, "node_modules", "@portable-devshell", "extension"), {
        recursive: true,
    });
    await mkdir(
        join(root, "node_modules", "@earendil-works", "pi-coding-agent"),
        { recursive: true },
    );
    await writeFile(
        join(root, "package.json"),
        JSON.stringify({ name: "source", type: "module", version: "9.9.9" }),
        "utf8",
    );

    await shapeThinAgentExtensionTree(root);
    await assertThinAgentExtensionTree(root);
    await assert.rejects(() => lstat(join(root, "node_modules")), /ENOENT/u);
    assert.equal(
        await readFile(join(root, "dist", "provider", "pi", "index.js"), "utf8"),
        "export {};\n",
    );
    const manifest = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
    );
    assert.equal(manifest.name, "@portable-devshell/agent-extension");
    assert.deepEqual(Object.keys(manifest.dependencies).sort(), []);
    const extensionManifest = JSON.parse(
        await readFile(join(root, "devshell-extension.json"), "utf8"),
    );
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
    const nestedBin = join(
        root,
        "node_modules",
        "esbuild",
        "node_modules",
        ".bin",
    );
    await mkdir(nestedBin, { recursive: true });
    await symlink(join(root, "plain"), join(nestedBin, "esbuild"));
    await sanitizeDeployTree(root);
    await assert.rejects(readFile(join(root, "pnpm-lock.yaml"), "utf8"));
    await assert.rejects(() => lstat(nestedBin), /ENOENT/u);

    await symlink(join(root, "plain"), join(root, "link"));
    await assert.rejects(() => assertNoSymbolicLinks(root), /symbolic link/u);
});

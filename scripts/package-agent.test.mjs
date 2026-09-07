import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
    assertNoSymbolicLinks,
    assertThinAgentExtensionTree,
    sanitizeDeployTree
} from "./package-agent.mjs";

const repoRoot = new URL("../", import.meta.url);

test("Agent Extension production dependency graph excludes Pi provider/runtime packages", async () => {
    const agentExtension = JSON.parse(await readFile(new URL("packages/agent-extension/package.json", repoRoot), "utf8"));
    const agentd = JSON.parse(await readFile(new URL("packages/agentd/package.json", repoRoot), "utf8"));
    const provider = JSON.parse(await readFile(new URL("packages/agent-provider-pi/package.json", repoRoot), "utf8"));

    assert.deepEqual(Object.keys(agentExtension.dependencies).sort(), [
        "@portable-devshell/agentd",
        "@portable-devshell/extension"
    ]);
    assert.deepEqual(Object.keys(agentd.dependencies), ["@portable-devshell/shared"]);
    assert.equal(provider.dependencies["@earendil-works/pi-coding-agent"], "0.84.4");
    assert.equal(provider.dependencies["@portable-devshell/pi-extension"], "workspace:*");
});

test("thin Agent Extension payload guard rejects Pi runtime content", async (t) => {
    const root = await mkdtemp(join(tmpdir(), "devshell-agent-thin-"));
    t.after(async () => await rm(root, { force: true, recursive: true }));
    await mkdir(join(root, "node_modules", "@portable-devshell", "agentd"), { recursive: true });
    await assertThinAgentExtensionTree(root);

    await mkdir(join(root, "node_modules", "@earendil-works", "pi-coding-agent"), { recursive: true });
    await assert.rejects(
        () => assertThinAgentExtensionTree(root),
        /must not contain Pi provider\/runtime content/u
    );
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

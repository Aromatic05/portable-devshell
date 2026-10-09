import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assertTestspaceLifecycleEnvironment } from "./TestspaceNamespace.mjs";
import { runTestspaceCommentSmoke } from "./TestspaceCommentSmoke.mjs";
import { withTestspaceControlConnection } from "./TestspaceReverse.mjs";

const extensionId = "comment";

/** Reject a broken candidate without retiring the serving Extension. */
export async function runTestspaceExtensionSmoke() {
    const root = process.env.DEVSHELL_TESTSPACE_ROOT;
    assertTestspaceLifecycleEnvironment(root, process.env);
    const initial = await inspect();
    assert.equal(initial.state, "active");
    const generation = initial.activeGeneration;
    assert.equal(generation, initial.selectedGeneration);
    assert.match(generation, /^v[0-9.]+-[a-f0-9]+$/u);
    const manifestPath = join(root, "home", ".local", "share", "portable-devshell", "extensions",
        extensionId, generation, "devshell-extension.json");
    const original = await readFile(manifestPath);
    const broken = JSON.parse(original.toString());
    assert.equal(broken.id, extensionId);
    broken.id = "testspace-invalid-extension-id";
    let failure;
    try {
        await writeFile(manifestPath, JSON.stringify(broken), { mode: 0o600 });
        await assert.rejects(extension("reload"), (error) => {
            failure = error.message;
            return typeof error.message === "string" && error.message.length > 0;
        });
        const active = await inspect();
        assert.equal(active.state, "active");
        assert.equal(active.activeGeneration, generation);
        assert.equal(active.selectedGeneration, generation);
        assert.equal(active.lastKnownGoodGeneration, generation);

        // Even while the broken candidate is on disk, its previously active
        // in-memory generation must continue processing genuine MCP tools.
        const state = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
        const delivered = await runTestspaceCommentSmoke({
            endpoint: `http://127.0.0.1:${state.mcpPort}/testspace-local/mcp`,
            instance: "testspace-local",
            runtimeDirectory: process.env.XDG_RUNTIME_DIR,
            workspace: join(root, "workspace"),
        });
        assert.equal(delivered.status, "delivered");
        return {
            rejectedCandidate: true,
            generationPreserved: true,
            messageDeliveredWhileCandidateBroken: true,
            failure: failure.trim().slice(0, 400),
        };
    } finally {
        await writeFile(manifestPath, original);
        // Reload the valid manifest to confirm the candidate can be loaded
        // again and the old generation retires without orphaned requests.
        await extension("reload");
        const restored = await inspect();
        assert.equal(restored.state, "active");
        assert.equal(restored.selectedGeneration, generation);
    }
}

async function inspect() {
    return await extension("get");
}

async function extension(operation) {
    return await withTestspaceControlConnection(process.env.XDG_RUNTIME_DIR, async (shared, endpoint) => {
        const client = shared.createExtensionRuntimeTransport(endpoint);
        return await client[operation](extensionId);
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    try {
        console.log(JSON.stringify(await runTestspaceExtensionSmoke(), null, 2));
    } catch (error) {
        console.error(error);
        process.exitCode = 1;
    }
}

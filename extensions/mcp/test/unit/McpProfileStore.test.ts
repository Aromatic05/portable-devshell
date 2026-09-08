import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { McpProfileStore, validateMcpProfile } from "../../src/builtin/McpProfileStore.ts";

test("MCP profile store persists validated profiles atomically and sorts them", async (t) => {
    const root = await createTestTempDirectory("mcp-profile-store");
    t.after(async () => await rm(root, { force: true, recursive: true }));
    const store = new McpProfileStore(root);

    await store.add(validateMcpProfile("zeta", "https://example.com/mcp#ignored"));
    await store.add(validateMcpProfile("alpha", "http://127.0.0.1:3000/mcp"));

    assert.deepEqual(await store.list(), [
        { name: "alpha", url: "http://127.0.0.1:3000/mcp" },
        { name: "zeta", url: "https://example.com/mcp" }
    ]);
    assert.deepEqual(await store.get("alpha"), { name: "alpha", url: "http://127.0.0.1:3000/mcp" });
    await assert.rejects(store.add(validateMcpProfile("alpha", "https://other.example/mcp")), /already exists/u);
    assert.deepEqual(await store.remove("zeta"), { name: "zeta", url: "https://example.com/mcp" });
    await assert.rejects(store.remove("missing"), /does not exist/u);

    const persisted = JSON.parse(await readFile(join(root, "profiles.json"), "utf8"));
    assert.deepEqual(persisted, {
        profiles: [{ name: "alpha", url: "http://127.0.0.1:3000/mcp" }],
        version: 1
    });
    if (process.platform !== "win32") {
        assert.equal((await stat(join(root, "profiles.json"))).mode & 0o777, 0o600);
    }
});

test("MCP profiles reject unsafe identities, schemes, and embedded credentials", () => {
    assert.throws(() => validateMcpProfile("../escape", "https://example.com/mcp"), /profile name/u);
    assert.throws(() => validateMcpProfile("demo", "file:///tmp/server"), /http or https/u);
    assert.throws(() => validateMcpProfile("demo", "https://user:pass@example.com/mcp"), /must not embed credentials/u);
});

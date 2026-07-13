import assert from "node:assert/strict";
import test from "node:test";

import { McpArtifactToolCatalog } from "../../dist/mcp/artifact/McpArtifactToolCatalog.js";

test("artifact control catalog exposes only share and transfer without documenting hidden host", () => {
    const tools = new McpArtifactToolCatalog().list();
    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["artifact_share", "artifact_transfer"]
    );
    const serialized = JSON.stringify(tools);
    assert.doesNotMatch(serialized, /\bhost\b/u);
    assert.match(serialized, /"start"/u);
    assert.match(serialized, /"status"/u);
    assert.match(serialized, /"cancel"/u);
});

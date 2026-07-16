import assert from "node:assert/strict";
import test from "node:test";

import { McpToolCatalogArtifact } from "../../dist/tool/catalog/McpToolCatalogArtifact.js";

test("artifact control catalog exposes only share and transfer without documenting hidden host", () => {
    const tools = new McpToolCatalogArtifact().list();
    assert.deepEqual(
        tools.map((tool) => tool.name),
        ["artifact_share", "artifact_transfer"]
    );
    const serialized = JSON.stringify(tools);
    assert.doesNotMatch(serialized, /\bhost\b/u);
    assert.match(serialized, /"start"/u);
    assert.match(serialized, /"status"/u);
    assert.match(serialized, /"cancel"/u);

    const share = tools.find((tool) => tool.name === "artifact_share")!;
    const shareSchema = share.inputSchema as {
        properties: Record<string, { description?: string }>;
    };
    assert.match(share.description, /exactly one of path or handle/u);
    assert.match(share.description, /defaults to 3600/u);
    assert.match(JSON.stringify(share.inputSchema), /"maximum":604800/u);
    assert.match(shareSchema.properties.handle.description ?? "", /previous artifact-producing tool result/u);
    assert.match(shareSchema.properties.path.description ?? "", /source instance/u);

    const transfer = tools.find((tool) => tool.name === "artifact_transfer")!;
    const transferSchema = transfer.inputSchema as {
        properties: Record<string, { description?: string }>;
    };
    assert.match(transfer.description, /exactly one of sourcePath or handle/u);
    assert.match(transfer.description, /operation=status or operation=cancel/u);
    assert.match(transferSchema.properties.targetInstance.description ?? "", /instance_list/u);
    assert.match(transferSchema.properties.transferId.description ?? "", /operation=start/u);
});

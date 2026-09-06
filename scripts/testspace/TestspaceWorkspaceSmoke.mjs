import assert from "node:assert/strict";

import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export async function runTestspaceWorkspaceSmoke({ endpoint, instance, workspace }) {
    const client = new Client({ name: "testspace-workspace-smoke", version: "0.0.0" });
    try {
        await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));

        const listed = await client.listResources();
        const workspaceResource = listed.resources.find((resource) => (
            resource.name === "portable-devshell Workspace" &&
            resource.uri.startsWith("ui://portable-devshell/workspace")
        ));
        assert.notEqual(
            workspaceResource,
            undefined,
            "Workspace resource is not discoverable from the Testspace MCP endpoint.",
        );
        const resource = await client.readResource({ uri: workspaceResource.uri });
        const html = resource.contents
            .map((content) => typeof content.text === "string" ? content.text : "")
            .join("\n");
        assert.match(html, /portable-devshell/iu);
        assert.match(html, /Workspace/u);

        const environment = await client.callTool({
            arguments: { workspace },
            name: "environ_info",
        });
        const ctxId = environment.structuredContent?.ctxId;
        assert.equal(typeof ctxId, "string");
        assert.notEqual(ctxId, "");
        const meta = environment._meta?.["portable-devshell/workspace"];
        assert.equal(typeof meta, "object");
        assert.notEqual(meta, null);
        const token = meta?.token;
        const liveBaseUrl = meta?.liveBaseUrl;
        assert.equal(typeof token, "string");
        assert.notEqual(token, "");
        assert.equal(typeof liveBaseUrl, "string");
        assert.notEqual(liveBaseUrl, "");

        const snapshotUrl = new URL(`${liveBaseUrl}/snapshot`);
        snapshotUrl.searchParams.set("ctxId", ctxId);
        const snapshotResponse = await fetch(snapshotUrl, {
            headers: { authorization: `Bearer ${token}` },
        });
        const snapshotText = await snapshotResponse.text();
        assert.equal(snapshotResponse.status, 200, snapshotText);
        const snapshot = JSON.parse(snapshotText);
        assert.equal(snapshot.ctxId, ctxId);
        assert.equal(snapshot.instance, instance);
        assert.equal(Number.isSafeInteger(snapshot.cursor), true);
        assert.equal(Array.isArray(snapshot.tasks), true);

        return {
            ctxId,
            cursor: snapshot.cursor,
            instance: snapshot.instance,
            liveBaseUrl,
            resourceUri: workspaceResource.uri,
        };
    } finally {
        await client.close().catch(() => undefined);
    }
}

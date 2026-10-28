import assert from "node:assert/strict";
import test from "node:test";

import { McpNativeToolResult, presentMcpEndpointResult } from "../../../src/protocol/call/Boundary.ts";

test("rewritten ToolCall native envelope preserves MCP image content", () => {
    const result = presentMcpEndpointResult(
        {
            structuredContent: {
                imageRef: "image.png",
                mediaType: "image/png",
                name: "image.png",
            },
            content: [
                {
                    data: "png-base64",
                    mimeType: "image/png",
                    type: "image",
                },
            ],
        },
        true,
    );
    assert.ok(result instanceof McpNativeToolResult);
    assert.deepEqual(result.content, [
        { data: "png-base64", mimeType: "image/png", type: "image" },
    ]);
    assert.deepEqual(result.structuredContent, {
        imageRef: "image.png",
        mediaType: "image/png",
        name: "image.png",
    });
});

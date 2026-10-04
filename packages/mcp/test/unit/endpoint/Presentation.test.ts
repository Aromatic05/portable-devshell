import assert from "node:assert/strict";
import test from "node:test";

import { McpNativeToolResult, presentMcpEndpointResult } from "../../../src/endpoint/call/Boundary.ts";

test("ToolCall image presentation maps to native MCP image content", () => {
    const result = presentMcpEndpointResult(
        {
            imageRef: "image.png",
            mediaType: "image/png",
            name: "image.png",
        },
        {
            content: [
                {
                    data: "png-base64",
                    mediaType: "image/png",
                    type: "image",
                },
            ],
        },
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

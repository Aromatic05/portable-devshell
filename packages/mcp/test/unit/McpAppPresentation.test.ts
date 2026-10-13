import assert from "node:assert/strict";
import { test } from "node:test";
import { asInstanceName } from "@portable-devshell/shared";

import { projectMcpAppActivity } from "../../src/mcpapp/Activity.ts";
import { mcpAppToolCallWidgetPayload } from "../../src/mcpapp/WidgetPayload.ts";

test("Inline Widget and Workspace activity apply the same secret and binary redaction", () => {
    const secretInput = {
        _meta: { bearer: "private-capability" },
        password: "secret-password",
        nested: { api_key: "secret-key", message: "authorization=Bearer abc123456" },
    };
    const secretOutput = {
        base64: "B".repeat(2_000),
        data: "D".repeat(2_000),
        token: "hidden-token",
        body: "-----BEGIN RSA PRIVATE KEY-----\nsensitive\n-----END RSA PRIVATE KEY-----",
    };
    const inline = mcpAppToolCallWidgetPayload("file_read", secretInput, secretOutput, false);
    const activity = projectMcpAppActivity([{
        callId: "call-1",
        ctxId: "ctx",
        input: secretInput,
        inputSummary: "",
        instance: asInstanceName("demo"),
        output: secretOutput,
        source: "mcp",
        startedAt: "2026-10-13T00:00:00.000Z",
        status: "completed",
        toolName: "file_read",
    }], "ctx");

    for (const view of [inline, activity]) {
        const content = JSON.stringify(view);
        for (const secret of ["secret-password", "secret-key", "abc123456",
            "hidden-token", "private-capability", "sensitive", "B".repeat(80), "D".repeat(80)])
            assert.equal(content.includes(secret), false, secret + " leaked");
        assert.match(content, /\[redacted\]/u);
        assert.match(content, /\[binary payload omitted\]/u);
    }
});

import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";
import { WorkerToolCatalog, WorkerToolInvoker } from "@portable-devshell/core";

test("WorkerToolInvoker enforces all JSON Schema constraints for input and output", async () => {
    const catalog = new WorkerToolCatalog();
    catalog.refresh([{
        access: "read",
        description: "Read a file.",
        group: "file",
        inputSchema: {
            type: "object",
            properties: {
                path: { type: "string" }
            },
            required: ["path"],
            additionalProperties: false
        },
        name: "file_read",
        outputSchema: {
            type: "object",
            properties: {
                type: { enum: ["file"] }
            },
            required: ["type"],
            additionalProperties: false
        }
    }]);
    const rpcClient = {
        async request(): Promise<JsonValue> {
            return { type: "directory" };
        }
    };
    const invoker = new WorkerToolInvoker(rpcClient as never, catalog);

    await assert.rejects(invoker.invoke("file_read", { path: "./file.txt", extra: true }), {
        code: "core.toolSchemaUnavailable"
    });
    await assert.rejects(invoker.invoke("file_read", { path: "./file.txt" }), {
        code: "core.toolSchemaUnavailable"
    });
});

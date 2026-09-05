import assert from "node:assert/strict";
import test from "node:test";

import type { JsonValue } from "@portable-devshell/shared";
import { WorkerToolCatalog, WorkerToolInvoker } from "@portable-devshell/core/testing";

test("WorkerToolInvoker treats current schemas as discovery metadata, not a wire firewall", async () => {
    const catalog = new WorkerToolCatalog();
    catalog.refresh([{
        requiredCapabilities: ["read"],
        description: "Read files in a batch.",
        group: "file",
        inputSchema: {
            type: "object",
            properties: {
                files: {
                    type: "array",
                    minItems: 1,
                    items: {
                        type: "object",
                        properties: { path: { type: "string" } },
                        required: ["path"],
                        additionalProperties: false
                    }
                }
            },
            required: ["files"],
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
    const calls: JsonValue[] = [];
    const rpcClient = {
        async request(_method: string, input: JsonValue): Promise<JsonValue> {
            calls.push(input);
            return { legacyContent: "1:legacy" };
        }
    };
    const invoker = new WorkerToolInvoker(rpcClient as never, catalog);

    assert.deepEqual(
        await invoker.invoke("file_read", { path: "./legacy.txt", view: "content" }),
        { legacyContent: "1:legacy" }
    );
    assert.deepEqual(calls, [{ path: "./legacy.txt", view: "content" }]);
});

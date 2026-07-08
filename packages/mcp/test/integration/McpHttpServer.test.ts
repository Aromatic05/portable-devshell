import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { McpHost } from "@portable-devshell/mcp";

const fixturesDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures");
type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

test("missing instance returns 404", async () => {
    const host = createHost();
    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/missing/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });

        assert.equal(response.status, 404);
    } finally {
        await host.stop();
    }
});

test("initialize succeeds over HTTP", async () => {
    const host = createHost();
    await host.start();

    try {
        const address = host.server.address;
        assert.notEqual(address, null);
        assert.equal(typeof address, "object");

        const response = await fetch(`http://127.0.0.1:${address.port}/demo/mcp`, {
            method: "POST",
            headers: {
                accept: "application/json, text/event-stream",
                "content-type": "application/json"
            },
            body: JSON.stringify(await readFixture("mcp-initialize.json"))
        });
        const payload = await response.json() as { result?: { protocolVersion?: string } };

        assert.equal(response.status, 200);
        assert.equal(typeof payload.result?.protocolVersion, "string");
        assert.equal(typeof response.headers.get("mcp-session-id"), "string");
    } finally {
        await host.stop();
    }
});

async function readFixture(name: string): Promise<JsonValue> {
    return JSON.parse(await readFile(resolve(fixturesDirectory, name), "utf8")) as JsonValue;
}

function createHost(): McpHost {
    return new McpHost({
        listenHost: "127.0.0.1",
        listenPort: 0,
        auth: { enabled: false, provider: "none" },
        instances: [
            {
                name: "demo",
                allowlist: ["bash_run"],
                worker: {
                    snapshot() {
                        return { ready: true };
                    },
                    listTools() {
                        return [{ name: "bash_run", description: "Run shell", inputSchema: { type: "object" } }];
                    },
                    async callTool(_toolName: string, _input: unknown, _context: { source: "mcp" }) {
                        return { exitCode: 0, stderr: "", stdout: "ok\n" };
                    }
                } as never
            }
        ]
    });
}

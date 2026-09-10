import assert from "node:assert/strict";
import test from "node:test";

import type {
    ExtensionContext,
    ExtensionJsonValue,
    ExtensionWorkerSession
} from "@portable-devshell/extension";

import { executeSecretModelCommand } from "../../src/builtin/SecretModelCommand.ts";

function context(events: string[]): ExtensionContext {
    return {
        capabilities: {
            workers: {
                async openSession(input): Promise<ExtensionWorkerSession> {
                    events.push(`open:${input.instance}:${input.workspace}`);
                    return session(events, input.instance ?? "", input.workspace);
                }
            }
        },
        generation: "g1",
        id: "secret",
        logger: { debug() {}, error() {}, info() {}, warn() {} },
        paths: {
            codeDirectory: "/code",
            dataDirectory: "/data",
            runtimeDirectory: "/runtime",
            stateDirectory: "/state"
        },
        register() {},
        version: "0.1.0"
    };
}

function session(events: string[], instance: string, workspace: string): ExtensionWorkerSession {
    return {
        closed: Promise.resolve(),
        environment: { homeDirectory: "/remote", platform: { arch: "x64", os: "linux" } },
        instance,
        workspace,
        async callTool(name, input): Promise<ExtensionJsonValue> {
            events.push(`${name}:${JSON.stringify(input)}`);
            if (name === "file_find") {
                return { entries: [{ path: "./src/config.ts", type: "file" }] };
            }
            if (name === "file_read") {
                return {
                    files: [{
                        content: '1:const token = "ghp_123456789012345678901234567890123456";',
                        path: "./src/config.ts"
                    }]
                };
            }
            throw new Error(`unexpected tool ${name}`);
        },
        async close() { events.push("close"); },
        listTools: () => []
    };
}

test("Secret model command scans the authoritative Worker workspace without returning secret values", async () => {
    const events: string[] = [];
    const result = await executeSecretModelCommand(
        context(events),
        ["scan"],
        {
            context: {
                async instanceReference() { return { current: true }; }
            },
            instance: "remote-one",
            requestId: "model-secret",
            signal: new AbortController().signal,
            workspace: "/remote/workspace"
        }
    );
    assert.equal(result.kind, "json");
    const value = result.kind === "json" ? result.value as {
        findings: Array<{ line: number; path: string; type: string }>;
    } : undefined;
    assert.deepEqual(value?.findings, [
        { line: 1, path: "src/config.ts", type: "github_token" },
        { line: 1, path: "src/config.ts", type: "generic_assignment" }
    ]);
    assert.equal(JSON.stringify(result).includes("ghp_"), false);
    assert.equal(events[0], "open:remote-one:/remote/workspace");
    assert.equal(events.at(-1), "close");
});

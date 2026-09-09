import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionInstanceCapability } from "@portable-devshell/extension/instance";
import type { CliModelCommandInvocationContext } from "@portable-devshell/extension/cli";

import { executeInstanceCommand } from "../../src/builtin/InstanceCommand.ts";

function fakeCapability(): ExtensionInstanceCapability {
    const snapshot = {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 3,
        name: "local-test",
        ready: true,
        status: "ready" as const
    };
    return {
        async create() { throw new Error("unused"); },
        async createSchema() { return {}; },
        async delete() {},
        async disable() {},
        async enable() {},
        async list() { return [{ enabled: true, mcpEnabled: true, name: "local-test", provider: "local", snapshot }]; },
        async readLogs(_name, query) {
            if (query?.fromSeq === 4) {
                return [{ at: "later", instanceName: "local-test", message: "next\n", seq: 4, stream: "stderr" }];
            }
            return [{ at: "now", instanceName: "local-test", message: "hello\n", seq: 3, stream: "stdout" }];
        },
        async refresh() { return snapshot; },
        async snapshot() { return snapshot; },
        async start() { return snapshot; },
        async stop() { return snapshot; },
        async validateCreate() { return {}; },
        async watchEvents(_name, watch) {
            assert.deepEqual(watch.eventTypes, ["log.appended"]);
            assert.equal(watch.fromSeq, 4);
            await watch.onEvent({ at: "later", instanceName: "local-test", seq: 4, type: "log.appended" });
        }
    };
}

function invocation(output: string[] = []): CliModelCommandInvocationContext {
    return {
        instance: "local-test",
        io: {
            async readInput() { return undefined; },
            async requestInput() {},
            async writeStderr(chunk) { output.push(`stderr:${chunk}`); },
            async writeStdout(chunk) { output.push(chunk); }
        },
        requestId: "request-1",
        signal: new AbortController().signal,
        workspace: "/workspace"
    };
}

test("Instance model command renders the public management capability", async () => {
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["list"], invocation()), {
        kind: "text",
        text: "local-test\tready\tready=true\n"
    });
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["logs", "local-test"], invocation()), {
        kind: "text",
        text: "[3] stdout hello\n"
    });
});

test("Instance model logs follow streams through public CLI I/O and Instance watchEvents", async () => {
    const output: string[] = [];
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["logs", "local-test", "-f"], invocation(output)), {
        kind: "text",
        text: ""
    });
    assert.deepEqual(output, ["[3] stdout hello\n", "[4] stderr next\n"]);
});

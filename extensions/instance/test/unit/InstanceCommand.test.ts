import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionInstanceCapability } from "@portable-devshell/extension/instance";
import type {
    CliModelCommandInvocationContext,
    CliModelInstanceReference
} from "@portable-devshell/extension/cli";

import { executeInstanceCommand } from "../../src/builtin/InstanceCommand.ts";

function snapshot(name: string) {
    return {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 3,
        name,
        ready: true,
        status: "ready" as const
    };
}

function fakeCapability(): ExtensionInstanceCapability {
    return {
        async create() { throw new Error("unused"); },
        async createSchema() { return {}; },
        async delete() {},
        async disable() {},
        async enable() {},
        async list() {
            return [
                { enabled: true, mcpEnabled: true, name: "local-test", provider: "local", snapshot: snapshot("local-test") },
                { enabled: true, mcpEnabled: true, name: "remote-test", provider: "ssh", snapshot: snapshot("remote-test") },
                { enabled: true, mcpEnabled: true, name: "masked-test", provider: "ssh", snapshot: snapshot("masked-test") }
            ];
        },
        async readLogs(name, query) {
            if (query?.fromSeq === 4) {
                return [{ at: "later", instanceName: name, message: "next\n", seq: 4, stream: "stderr" }];
            }
            return [{ at: "now", instanceName: name, message: "hello\n", seq: 3, stream: "stdout" }];
        },
        async refresh(name) { return snapshot(name); },
        async snapshot(name) { return snapshot(name); },
        async start(name) { return snapshot(name); },
        async stop(name) { return snapshot(name); },
        async validateCreate() { return {}; },
        async watchEvents(name, watch) {
            assert.deepEqual(watch.eventTypes, ["log.appended"]);
            assert.equal(watch.fromSeq, 4);
            await watch.onEvent({ at: "later", instanceName: name, seq: 4, type: "log.appended" });
        }
    };
}

function invocation(
    output: string[] = [],
    references: Readonly<Record<string, CliModelInstanceReference | undefined>> = {
        "local-test": { current: true },
        "remote-test": { current: false, handle: "ih-remote" },
        "masked-test": undefined
    }
): CliModelCommandInvocationContext {
    return {
        context: {
            async instanceReference(instance) {
                return references[instance];
            }
        },
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

test("Instance model list is Context-filtered and exposes handles only for remote instances", async () => {
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["list"], invocation()), {
        kind: "text",
        text: [
            "local-test\tready\tready=true\tcurrent=true",
            "remote-test\tready\tready=true\thandle=ih-remote",
            ""
        ].join("\n")
    });
});

test("Instance model status exposes a remote handle and rejects masked instances", async () => {
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["status", "remote-test"], invocation()), {
        kind: "text",
        text: [
            "instance: remote-test",
            "status: ready",
            "ready: true",
            "daemonState: running",
            "connectionState: connected",
            "lastSeq: 3",
            "handle: ih-remote",
            ""
        ].join("\n")
    });
    await assert.rejects(
        executeInstanceCommand(fakeCapability(), ["status", "masked-test"], invocation()),
        /unavailable in the current Context/u
    );
});

test("Instance model command has no Context-mutating connect subcommand", async () => {
    await assert.rejects(
        executeInstanceCommand(fakeCapability(), ["connect", "remote-test"], invocation()),
        /Unknown instance model command: connect/u
    );
});

test("Instance model logs follow streams through public CLI I/O and Instance watchEvents", async () => {
    const output: string[] = [];
    assert.deepEqual(await executeInstanceCommand(fakeCapability(), ["logs", "local-test", "-f"], invocation(output)), {
        kind: "text",
        text: ""
    });
    assert.deepEqual(output, ["[3] stdout hello\n", "[4] stderr next\n"]);
});

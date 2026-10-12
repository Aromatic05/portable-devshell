import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type { ExtensionInstanceObserveCapability } from "@portable-devshell/extension/instance";
import type {
    CliModelCommandInvocationContext,
    CliModelInstanceReference,
} from "@portable-devshell/extension/cli";

import { executeInstanceCommand } from "../../src/builtin/InstanceCommand.ts";

function snapshot(name: string) {
    return {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 3,
        name,
        ready: true,
        status: "ready" as const,
    };
}

function fakeCapability(): ExtensionInstanceObserveCapability {
    return {
        async list() {
            return [
                {
                    enabled: true,
                    mcpEnabled: true,
                    name: "local-test",
                    provider: "local",
                    snapshot: snapshot("local-test"),
                },
                {
                    enabled: true,
                    mcpEnabled: true,
                    name: "remote-test",
                    provider: "ssh",
                    snapshot: snapshot("remote-test"),
                },
                {
                    enabled: true,
                    mcpEnabled: true,
                    name: "masked-test",
                    provider: "ssh",
                    snapshot: snapshot("masked-test"),
                },
            ];
        },
        async readLogs(name, query) {
            if (query?.fromSeq === 4) {
                return [
                    {
                        at: "later",
                        instanceName: name,
                        message: "next\n",
                        seq: 4,
                        stream: "stderr",
                    },
                ];
            }
            return [
                {
                    at: "now",
                    instanceName: name,
                    message: "hello\n",
                    seq: 3,
                    stream: "stdout",
                },
            ];
        },
        async refresh(name) {
            return snapshot(name);
        },
        async snapshot(name) {
            return snapshot(name);
        },
        async watchEvents(name, watch) {
            assert.deepEqual(watch.eventTypes, ["log.appended"]);
            assert.equal(watch.fromSeq, 4);
            await watch.onEvent({
                at: "later",
                instanceName: name,
                seq: 4,
                type: "log.appended",
            });
        },
    };
}

function invocation(
    output: string[] = [],
    references: Readonly<
        Record<string, CliModelInstanceReference | undefined>
    > = {
        "local-test": { current: true },
        "remote-test": { current: false, handle: "ih-remote" },
        "masked-test": undefined,
    },
): CliModelCommandInvocationContext {
    return {
        context: {
            async instanceReference(instance) {
                return references[instance];
            },
        },
        instance: "local-test",
        io: {
            async readInput() {
                return undefined;
            },
            async requestInput() {},
            async writeStderr(chunk) {
                output.push(`stderr:${chunk}`);
            },
            async writeStdout(chunk) {
                output.push(chunk);
            },
        },
        requestId: "request-1",
        signal: new AbortController().signal,
        workspace: "/workspace",
    };
}

test("Instance model list is Context-filtered and exposes handles only for remote instances", async () => {
    assert.deepEqual(
        await executeInstanceCommand(fakeCapability(), ["list"], invocation()),
        {
            kind: "text",
            text: [
                "local-test\tready\tready=true\tcurrent=true",
                "remote-test\tready\tready=true\thandle=ih-remote",
                "",
            ].join("\n"),
        },
    );
});

test("Instance model status exposes a remote handle and rejects masked instances", async () => {
    assert.deepEqual(
        await executeInstanceCommand(
            fakeCapability(),
            ["status", "remote-test"],
            invocation(),
        ),
        {
            kind: "text",
            text: [
                "instance: remote-test",
                "status: ready",
                "ready: true",
                "daemonState: running",
                "connectionState: connected",
                "lastSeq: 3",
                "handle: ih-remote",
                "",
            ].join("\n"),
        },
    );
    await assert.rejects(
        executeInstanceCommand(
            fakeCapability(),
            ["status", "masked-test"],
            invocation(),
        ),
        /unavailable in the current Context/u,
    );
});

test("Instance model command has no Context-mutating connect subcommand", async () => {
    await assert.rejects(
        executeInstanceCommand(
            fakeCapability(),
            ["connect", "remote-test"],
            invocation(),
        ),
        /Unknown instance model command: connect/u,
    );
});

test("Instance model logs follow streams through public CLI I/O and Instance watchEvents", async () => {
    const output: string[] = [];
    assert.deepEqual(
        await executeInstanceCommand(
            fakeCapability(),
            ["logs", "local-test", "-f"],
            invocation(output),
        ),
        {
            kind: "text",
            text: "",
        },
    );
    assert.deepEqual(output, ["[3] stdout hello\n", "[4] stderr next\n"]);
});

test("Instance model create forwards different provider drafts to the existing manage capability", async () => {
    const created: ExtensionJsonValue[] = [];
    const manage = {
        async create(draft: ExtensionJsonValue) {
            created.push(draft);
            return { name: (draft as { name: string }).name, enabled: false };
        },
    };
    const drafts = [
        { name: "local-new", provider: "local", enabled: false },
        { name: "ssh-new", provider: "ssh", enabled: false, ssh: { command: "ssh example.invalid" } },
        { name: "reverse-new", provider: "reverse", enabled: false },
        { name: "docker-new", provider: "docker", enabled: false, container: { mode: "existingImage", image: "alpine:latest" } },
        { name: "podman-new", provider: "podman", enabled: false, container: { mode: "existingImage", image: "alpine:latest" } },
    ];
    for (const draft of drafts) {
        assert.deepEqual(
            await executeInstanceCommand(fakeCapability(), ["create", JSON.stringify(draft)], invocation(), manage),
            { kind: "json", value: { name: draft.name, enabled: false } },
        );
    }
    assert.deepEqual(created, drafts);
});

test("Instance model create rejects invalid arguments before invoking management", async () => {
    let calls = 0;
    const manage = {
        async create() {
            calls++;
            return { name: "unexpected", enabled: false };
        },
    };
    for (const argv of [
        ["create"],
        ["create", "{}", "extra"],
        ["create", "{"],
        ["create", "null"],
        ["create", "42"],
        ["create", "true"],
        ["create", "[]"],
    ]) {
        await assert.rejects(
            executeInstanceCommand(fakeCapability(), argv, invocation(), manage),
            /instance create/u,
        );
    }
    assert.equal(calls, 0);
    await assert.rejects(
        executeInstanceCommand(fakeCapability(), ["create", "{}"], invocation()),
        /instance\.manage/u,
    );
    const help = await executeInstanceCommand(fakeCapability(), ["help"], invocation());
    assert.equal(help.kind, "text");
    assert.match(help.text ?? "", /devshell instance create/u);
});

test("Instance model create propagates management errors and rejects aborted calls", async () => {
    const failure = new Error("Host refused duplicate Instance");
    let calls = 0;
    const manage = {
        async create() {
            calls++;
            throw failure;
        },
    };
    const draft = JSON.stringify({ name: "duplicate", provider: "local" });
    await assert.rejects(
        executeInstanceCommand(fakeCapability(), ["create", draft], invocation(), manage),
        (error) => error === failure,
    );
    assert.equal(calls, 1);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
        executeInstanceCommand(
            fakeCapability(),
            ["create", draft],
            { ...invocation(), signal: controller.signal },
            manage,
        ),
        (error) => error === controller.signal.reason,
    );
    assert.equal(calls, 1);
});

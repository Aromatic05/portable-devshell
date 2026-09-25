import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import type { ConfigMcpPatch, ConfigView } from "@portable-devshell/shared";

import type { CliDispatchContext } from "../../src/command/Dispatch.js";
import { executeInit } from "../../src/command/Init.js";

test("init starts stopped Control before reconciling first-run state through RPC", async () => {
    const calls: string[] = [];
    let view = configView({ enabled: false, instances: [], token: undefined });
    let renderedText = "";
    const context = {
        clients: {
            config: {
                async get() {
                    return view;
                },
                async update(request: { mcp?: ConfigMcpPatch }) {
                    calls.push("config.update");
                    assert.equal(request.mcp?.enabled, true);
                    assert.equal(request.mcp?.oauth2?.approval, "token");
                    assert.match(
                        request.mcp?.oauth2?.token ?? "",
                        /^ds_[A-Za-z0-9_-]{40,}$/u,
                    );
                    view = configView({
                        enabled: true,
                        instances: view.instances,
                        token: "********",
                    });
                    return {};
                },
            },
            async reconnect() {
                calls.push("reconnect");
            },
            instance: {
                async create(draft: unknown) {
                    calls.push("instance.create");
                    assert.deepEqual(draft, {
                        mcp: { contextMode: "openai-session" },
                        name: "local-pc",
                        provider: "local",
                    });
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime: {
                async start(instance: string) {
                    calls.push(`start:${instance}`);
                    return readySnapshot(instance);
                },
            },
        },
        controlNegotiated: false,
        async lifecycle() {
            return {
                async start() {
                    calls.push("control.start");
                    return { instanceCount: 0, pid: 1, running: true };
                },
            };
        },
        async negotiate() {
            calls.push("negotiate");
        },
        stdin: Readable.from([]),
        stderr: { write() {} },
        writeValue(_value: unknown, text: string) {
            renderedText = text;
        },
    } as unknown as CliDispatchContext;

    assert.equal(await executeInit({ kind: "init" }, context), true);
    assert.deepEqual(calls, [
        "control.start",
        "reconnect",
        "negotiate",
        "config.update",
        "instance.create",
        "start:local-pc",
    ]);
    assert.match(renderedText, /Instance: local-pc \(ready\)/u);
    assert.match(renderedText, /http:\/\/127\.0\.0\.1:17890\/local-pc\/mcp/u);
    assert.match(renderedText, /ds_[A-Za-z0-9_-]{40,}/u);

});

test("init reconciles a running fresh-like Control through RPC without restarting it", async () => {
    const calls: string[] = [];
    let view = configView({ enabled: false, instances: [], token: undefined });
    let renderedText = "";
    const context = {
        clients: {
            config: {
                async get() {
                    return view;
                },
                async update(request: { mcp?: ConfigMcpPatch }) {
                    calls.push("config.update");
                    assert.equal(request.mcp?.enabled, true);
                    assert.equal(request.mcp?.oauth2?.approval, "token");
                    assert.match(
                        request.mcp?.oauth2?.token ?? "",
                        /^ds_[A-Za-z0-9_-]{40,}$/u,
                    );
                    view = configView({
                        enabled: true,
                        instances: view.instances,
                        token: "********",
                    });
                    return {};
                },
            },
            instance: {
                async create(draft: unknown) {
                    calls.push("instance.create");
                    assert.deepEqual(draft, {
                        mcp: { contextMode: "openai-session" },
                        name: "local-pc",
                        provider: "local",
                    });
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime: {
                async start(instance: string) {
                    calls.push(`start:${instance}`);
                    return readySnapshot(instance);
                },
            },
        },
        controlNegotiated: true,
        async lifecycle() {
            throw new Error("running init must not restart Control");
        },
        async negotiate() {
            throw new Error("running init is already negotiated");
        },
        stdin: Readable.from([]),
        stderr: { write() {} },
        writeValue(_value: unknown, text: string) {
            renderedText = text;
        },
    } as unknown as CliDispatchContext;

    assert.equal(await executeInit({ kind: "init" }, context), true);
    assert.deepEqual(calls, [
        "config.update",
        "instance.create",
        "start:local-pc",
    ]);
    assert.match(renderedText, /DevShell is initialized/u);
    assert.match(renderedText, /ds_[A-Za-z0-9_-]{40,}/u);
});

test("init preserves TUI approval and reuses an existing local instance", async () => {
    const calls: string[] = [];
    const view = configView({ token: "********" });
    view.mcp.oauth2 = { approval: "tui" };
    view.instances = [
        {
            ...view.instances[0]!,
            mcp: {
                ...view.instances[0]!.mcp,
                path: "/work-station/mcp",
            },
            name: "work-station",
        },
    ];
    let renderedText = "";
    const context = {
        clients: {
            config: {
                async get() {
                    return view;
                },
                async update() {
                    throw new Error("existing TUI approval must be preserved");
                },
            },
            instance: {
                async create() {
                    throw new Error("existing local instance must be reused");
                },
            },
            runtime: {
                async start(instance: string) {
                    calls.push(`start:${instance}`);
                    return readySnapshot(instance);
                },
            },
        },
        controlNegotiated: true,
        stdin: Readable.from([]),
        stderr: { write() {} },
        writeValue(_value: unknown, text: string) {
            renderedText = text;
        },
    } as unknown as CliDispatchContext;

    assert.equal(await executeInit({ kind: "init" }, context), true);
    assert.deepEqual(calls, ["start:work-station"]);
    assert.match(
        renderedText,
        /TUI approval \(existing configuration preserved\)/u,
    );
    assert.doesNotMatch(renderedText, /ds_[A-Za-z0-9_-]{40,}/u);
});

test("fresh interactive init offers Cloudflare through the Access native command", async () => {
    const calls: string[] = [];
    let view = configView({ enabled: false, instances: [], token: undefined });
    let output = "";
    const stdin = Readable.from(["1\n"]) as Readable & { isTTY: boolean };
    stdin.isTTY = true;
    const context = {
        clients: {
            cli: {
                async command(commandId: string, args: readonly string[], options: unknown) {
                    calls.push(`cli:${commandId}:${args.join(" ")}`);
                    assert.equal(commandId, "access");
                    assert.deepEqual(args, ["cloudflare"]);
                    assert.notEqual(options, undefined);
                    return {
                        kind: "text",
                        text: "Cloudflare tunnel configured.\n",
                    };
                },
            },
            config: {
                async get() {
                    return view;
                },
                async update() {
                    view = configView({
                        enabled: true,
                        instances: view.instances,
                        token: "********",
                    });
                    return {};
                },
            },
            instance: {
                async create() {
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime: {
                async start(instance: string) {
                    return readySnapshot(instance);
                },
            },
        },
        controlNegotiated: true,
        outputFormat: "text",
        stdin,
        stderr: { write() {} },
        stdout: {
            write(chunk: string) {
                output += chunk;
            },
        },
        writeJson() {},
        writeValue(_value: unknown, text: string) {
            output += text;
        },
    } as unknown as CliDispatchContext;

    assert.equal(await executeInit({ kind: "init" }, context), true);
    assert.deepEqual(calls, ["cli:access:cloudflare"]);
    assert.match(output, /Remote access\?/u);
    assert.match(output, /1\. Cloudflare Tunnel/u);
    assert.match(output, /Cloudflare tunnel configured\./u);
});

function configView(input?: {
    enabled?: boolean;
    instances?: ConfigView["instances"];
    token?: string;
}): ConfigView {
    return {
        control: { artifactDirectTransfer: false, logLevel: "info" },
        instances:
            input?.instances ??
            ([
                {
                    enabled: true,
                    mcp: {
                        auth: {
                            mode: "oauth2",
                            oauth2: {
                                requiredScopes: ["mcp"],
                                resourceName: "local-pc",
                            },
                        },
                        contextMode: "explicit",
                        enabled: true,
                        path: "/local-pc/mcp",
                    },
                    name: "local-pc",
                    provider: "local",
                    security: { effectiveMode: "disabled", mode: "disabled" },
                },
            ] as unknown as ConfigView["instances"]),
        mcp: {
            enabled: input?.enabled ?? true,
            listenHost: "127.0.0.1",
            listenPort: 17890,
            oauth2: {
                approval: "token",
                ...(input?.token === undefined ? {} : { token: input.token }),
            },
            publicBaseUrl: "http://127.0.0.1:17890",
        },
        restartControlRequired: false,
        web: {
            auth: "none",
            enabled: false,
            listenHost: "127.0.0.1",
            listenPort: 17891,
            publicBaseUrl: "http://127.0.0.1:17891",
        },
    };
}

function readySnapshot(name: string) {
    return {
        connectionState: "connected" as const,
        daemonState: "running" as const,
        lastSeq: 1,
        name,
        ready: true,
        status: "ready" as const,
    };
}

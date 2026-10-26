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
                async createInstance(draft: unknown) {
                    calls.push("instance.create");
                    assert.deepEqual(draft, {
                        mcp: {
                            auth: "oauth2",
                            contextMode: "openai-session",
                            oauth2: {
                                requiredScopes: ["mcp"],
                                resourceName: "local-pc",
                            },
                        },
                        name: "local-pc",
                        provider: "local",
                    });
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime(instance: string) {
                return {
                    async start() {
                        calls.push(`start:${instance}`);
                        return readySnapshot(instance);
                    },
                };
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
                async createInstance(draft: unknown) {
                    calls.push("instance.create");
                    assert.deepEqual(draft, {
                        mcp: {
                            auth: "oauth2",
                            contextMode: "openai-session",
                            oauth2: {
                                requiredScopes: ["mcp"],
                                resourceName: "local-pc",
                            },
                        },
                        name: "local-pc",
                        provider: "local",
                    });
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime(instance: string) {
                return {
                    async start() {
                        calls.push(`start:${instance}`);
                        return readySnapshot(instance);
                    },
                };
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
                async createInstance() {
                    throw new Error("existing local instance must be reused");
                },
            },
            runtime(instance: string) {
                return {
                    async start() {
                        calls.push(`start:${instance}`);
                        return readySnapshot(instance);
                    },
                };
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

test("fresh interactive init offers Access choices through the optional Access command", async () => {
    const calls: string[] = [];
    let view = configView({ enabled: false, instances: [], token: undefined });
    let output = "";
    const stdin = Readable.from(["2\n"]) as Readable & { isTTY: boolean };
    stdin.isTTY = true;
    const context = {
        clients: {
            cli: {
                async commands() {
                    return [{ id: "access" }];
                },
                async command(
                    commandId: string,
                    args: readonly string[],
                    options: unknown,
                ) {
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
                async createInstance() {
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime(instance: string) {
                return { async start() { return readySnapshot(instance); } };
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
    assert.match(output, /MCP access/u);
    assert.match(output, /1\. Already public/u);
    assert.match(output, /2\. Cloudflare Tunnel/u);
    assert.match(output, /3\. SSH reverse/u);
    assert.match(output, /Cloudflare tunnel configured\./u);
});

test("fresh interactive init silently skips Access when the Access command is absent", async () => {
    let view = configView({ enabled: false, instances: [], token: undefined });
    let output = "";
    const stdin = Readable.from([]) as Readable & { isTTY: boolean };
    stdin.isTTY = true;
    const context = {
        clients: {
            cli: {
                async commands() {
                    return [];
                },
                async command() {
                    throw new Error("Access must not be invoked");
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
                async createInstance() {
                    view = configView({ token: "********" });
                    return { enabled: true, name: "local-pc" };
                },
            },
            runtime(instance: string) {
                return { async start() { return readySnapshot(instance); } };
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
        writeValue(_value: unknown, text: string) {
            output += text;
        },
    } as unknown as CliDispatchContext;

    assert.equal(await executeInit({ kind: "init" }, context), true);
    assert.doesNotMatch(output, /MCP access/u);
});

for (const failure of ["read", "collision", "create", "start"] as const) {
    test(`init delivers the persisted approval token before a subsequent ${failure} failure`, async () => {
        const view = configView({ token: undefined });
        view.instances = failure === "start" ? view.instances : [];
        if (failure === "collision") {
            view.instances = [
                { ...configView().instances[0]!, provider: "ssh" },
            ] as unknown as ConfigView["instances"];
        }
        let savedToken: string | undefined;
        let output = "";
        let reads = 0;
        const context = {
            clients: {
                config: {
                    async get() {
                        reads += 1;
                        if (failure === "read" && reads === 2)
                            throw new Error("config read failed");
                        return view;
                    },
                    async update(request: { mcp: ConfigMcpPatch }) {
                        savedToken = request.mcp.oauth2?.token;
                    },
                },
                instance: {
                    async createInstance() {
                        throw new Error("instance create failed");
                    },
                },
                runtime() {
                    return {
                        async start() {
                            throw new Error("instance start failed");
                        },
                    };
                },
            },
            controlNegotiated: true,
            stderr: { write(chunk: string) { output += chunk; } },
            writeValue() { assert.fail("failed init must not report success"); },
        } as unknown as CliDispatchContext;

        const errors = {
            read: /config read failed/u,
            collision: /already exists with provider ssh/u,
            create: /instance create failed/u,
            start: /instance start failed/u,
        };
        await assert.rejects(executeInit({ kind: "init" }, context), errors[failure]);
        assert.match(savedToken ?? "", /^ds_[A-Za-z0-9_-]{40,}$/u);
        assert.equal(output, `OAuth2 approval\n  ${savedToken}\n`);
    });
}

test("init does not deliver an approval token when its write fails", async () => {
    let output = "";
    const context = {
        clients: {
            config: {
                async get() { return configView(); },
                async update() { throw new Error("config write failed"); },
            },
        },
        controlNegotiated: true,
        stderr: { write(chunk: string) { output += chunk; } },
    } as unknown as CliDispatchContext;

    await assert.rejects(executeInit({ kind: "init" }, context), /config write failed/u);
    assert.equal(output, "");
});

for (const enabled of [true, false]) {
    test(`init renders MCP enabled=${enabled} without a public URL accurately`, async () => {
        const view = configView({ enabled, token: "********" });
        delete view.mcp.publicBaseUrl;
        let output = "";
        let result: unknown;
        const context = {
            clients: {
                config: { async get() { return view; } },
                runtime(instance: string) {
                    return { async start() { return readySnapshot(instance); } };
                },
            },
            controlNegotiated: true,
            writeValue(value: unknown, text: string) {
                result = value;
                output = text;
            },
        } as unknown as CliDispatchContext;

        assert.equal(await executeInit({ kind: "init" }, context), true);
        assert.equal((result as { mcpEnabled: boolean }).mcpEnabled, enabled);
        assert.match(output, enabled
            ? /enabled \(public URL not configured\)/u
            : /disabled \(existing configuration preserved\)/u);
    });
}

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

test("interactive init validates a public base URL and displays the complete endpoint", async () => {
    let view = configView({ instances: [], token: undefined });
    const saved: ConfigMcpPatch[] = [];
    let output = "";
    const stdin = Readable.from(["1\nnot-a-url\nftp://example.test\nhttps://user:pass@example.test\nhttps://example.test/?token=bad\nhttps://example.test/local-pc/mcp\nhttps://example.test/proxy/?\n"]) as Readable & { isTTY: boolean };
    stdin.isTTY = true;
    await executeInit({ kind: "init" }, {
        controlNegotiated: true, outputFormat: "text", stdin,
        stdout: { write(text: string) { output += text; } }, stderr: { write() {} },
        writeValue() {},
        clients: {
            config: {
                async get() { return view; },
                async update(patch: { mcp: ConfigMcpPatch }) { saved.push(patch.mcp); return {}; },
            },
            instance: { async createInstance() { view = configView({ token: "masked" }); } },
            runtime() { return { async start() { return readySnapshot("local-pc"); } }; },
            cli: { async commands() { return [{ id: "access" }]; } },
        },
    } as unknown as CliDispatchContext);
    assert.deepEqual(saved.at(-1), { publicBaseUrl: "https://example.test/proxy" });
    assert.equal(saved.filter((patch) => patch.publicBaseUrl !== undefined).length, 1);
    assert.match(output, /Public base URL/u);
    assert.match(output, /without the Instance endpoint/u);
    assert.match(output, /MCP endpoint: https:\/\/example\.test\/proxy\/local-pc\/mcp/u);
    assert.doesNotMatch(output, /mcp\/local-pc\/mcp/u);
});

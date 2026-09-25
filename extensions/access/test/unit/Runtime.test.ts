import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";

import type {
    ExtensionConfig,
    ExtensionConfigChange,
    ExtensionContext,
    ExtensionJsonValue,
} from "@portable-devshell/extension";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { AccessRuntime } from "../../src/builtin/AccessRuntime.ts";
import type {
    AccessProvider,
    AccessProviderOpenInput,
    AccessProviderSession,
} from "../../src/builtin/provider/AccessProvider.ts";
import { executeAccessCommand } from "../../src/builtin/AccessCommand.ts";

class MemoryConfig implements ExtensionConfig {
    readonly #listeners = new Set<(change: ExtensionConfigChange) => void>();
    readonly values = new Map<string, ExtensionJsonValue>();

    constructor() {
        this.values.set("access.endpoints", []);
        this.values.set("mcp.enabled", true);
        this.values.set("mcp.listenHost", "0.0.0.0");
        this.values.set("mcp.listenPort", 47123);
        this.values.set("mcp.publicBaseUrl", "https://mcp.example.test");
        this.values.set("web.enabled", true);
        this.values.set("web.listenHost", "127.0.0.1");
        this.values.set("web.listenPort", 47124);
        this.values.set("web.publicBaseUrl", "https://web.example.test");
    }

    async get(path: string): Promise<ExtensionJsonValue | undefined> {
        return structuredClone(this.values.get(path));
    }

    onChange(listener: (change: ExtensionConfigChange) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async update(patch: Readonly<Record<string, ExtensionJsonValue>>): Promise<void> {
        for (const [path, value] of Object.entries(patch))
            this.values.set(path, structuredClone(value));
        const change = { paths: Object.freeze(Object.keys(patch)) };
        for (const listener of [...this.#listeners]) listener(change);
    }
}

class FakeSession implements AccessProviderSession {
    readonly closed: Promise<void>;
    readonly process = {} as never;
    readonly #listeners = new Set<(publicUrl: string) => void>();
    #url: string | undefined;
    #resolve!: () => void;
    stopFailure?: Error;
    stops = 0;

    constructor(url: string | undefined) {
        this.#url = url;
        this.closed = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    closeUnexpectedly(): void {
        this.#resolve();
    }

    onPublicUrlChange(listener: (publicUrl: string) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    publicUrl(): string | undefined {
        return this.#url;
    }

    setPublicUrl(publicUrl: string): void {
        this.#url = publicUrl;
        for (const listener of [...this.#listeners]) listener(publicUrl);
    }

    async stop(): Promise<void> {
        this.stops += 1;
        if (this.stopFailure !== undefined) throw this.stopFailure;
        this.#resolve();
        await this.closed;
    }
}

class FakeSshProvider implements AccessProvider {
    readonly kind = "ssh" as const;
    readonly opens: AccessProviderOpenInput[] = [];
    readonly sessions: FakeSession[] = [];

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        this.opens.push(input);
        const session = new FakeSession(`https://public-${this.opens.length}.example.test/`);
        this.sessions.push(session);
        return session;
    }
}

class FakeCloudflaredProvider implements AccessProvider {
    readonly kind = "cloudflared" as const;
    readonly opens: AccessProviderOpenInput[] = [];
    readonly sessions: FakeSession[] = [];

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        this.opens.push(input);
        const session = new FakeSession(undefined);
        this.sessions.push(session);
        return session;
    }
}

class SelectiveFailSshProvider implements AccessProvider {
    readonly kind = "ssh" as const;
    readonly opens: AccessProviderOpenInput[] = [];
    readonly sessions = new Map<string, FakeSession[]>();

    async open(input: AccessProviderOpenInput): Promise<AccessProviderSession> {
        this.opens.push(input);
        if (input.endpoint.id === "slow-failure")
            throw new Error("provider unavailable");
        const session = new FakeSession(
            `https://${input.endpoint.id}-${this.opens.length}.example.test/`,
        );
        const sessions = this.sessions.get(input.endpoint.id) ?? [];
        sessions.push(session);
        this.sessions.set(input.endpoint.id, sessions);
        return session;
    }
}

function context(directory: string, config: MemoryConfig): ExtensionContext {
    return {
        capabilities: {
            processes: {
                async start() {
                    throw new Error("Runtime test must use the injected fake provider.");
                },
            },
        },
        config,
        generation: "test-generation",
        id: "access",
        logger: {
            debug() {},
            error() {},
            info() {},
            warn() {},
        },
        paths: {
            codeDirectory: directory,
            dataDirectory: directory,
            runtimeDirectory: directory,
            stateDirectory: directory,
        },
        register() {},
        version: "0.1.0",
    };
}

const sshEndpoint = {
    enabled: true,
    host: "gateway.example.test",
    id: "ssh-main",
    provider: "ssh",
    publicUrl: "https://gateway.example.test:9443/",
    remotePort: 9443,
    target: "mcp",
} as const;

test("AccessRuntime reconciles Config into providers and restarts when the Core target changes", async () => {
    const directory = await createTestTempDirectory("access-runtime");
    const config = new MemoryConfig();
    const provider = new FakeSshProvider();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [provider],
        reconcileDelayMs: 60_000,
    });
    try {
        await runtime.reconcile();
        assert.deepEqual(runtime.list(), []);

        const created = await runtime.upsert(sshEndpoint);
        assert.equal(created.state, "running");
        assert.equal(provider.opens.length, 1);
        assert.equal(provider.opens[0]?.target.origin.href, "http://127.0.0.1:47123/");
        assert.equal(runtime.get("ssh-main")?.publicUrl, "https://public-1.example.test/");

        await config.update({ "mcp.listenPort": 48123 });
        await runtime.reconcile();
        assert.equal(provider.opens.length, 2);
        assert.equal(provider.sessions[0]?.stops, 1);
        assert.equal(provider.opens[1]?.target.origin.href, "http://127.0.0.1:48123/");

        const disabled = await runtime.setEnabled("ssh-main", false);
        assert.equal(disabled.state, "disabled");
        assert.equal(provider.sessions[1]?.stops, 1);

        await runtime.setEnabled("ssh-main", true);
        assert.equal(provider.opens.length, 3);
        provider.sessions[2]?.closeUnexpectedly();
        await Promise.resolve();
        await Promise.resolve();
        assert.equal(runtime.get("ssh-main")?.state, "error");
        assert.match(runtime.get("ssh-main")?.error ?? "", /exited/u);

        assert.deepEqual(await runtime.remove("ssh-main"), {
            id: "ssh-main",
            removed: true,
        });
        assert.equal(runtime.get("ssh-main"), undefined);
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessRuntime waits instead of starting a tunnel when the target endpoint is disabled", async () => {
    const directory = await createTestTempDirectory("access-runtime-disabled-target");
    const config = new MemoryConfig();
    await config.update({ "web.enabled": false });
    const provider = new FakeSshProvider();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [provider],
        reconcileDelayMs: 60_000,
    });
    try {
        await runtime.upsert({ ...sshEndpoint, id: "web-ssh", target: "web" });
        assert.equal(provider.opens.length, 0);
        assert.equal(runtime.get("web-ssh")?.state, "waiting");
        assert.match(runtime.get("web-ssh")?.error ?? "", /disabled/u);
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessRuntime publishes a discovered Cloudflare URL without overwriting a later manual URL", async () => {
    const directory = await createTestTempDirectory("access-runtime-cloudflare-url");
    const config = new MemoryConfig();
    await config.update({ "mcp.publicBaseUrl": "http://127.0.0.1:47123" });
    const provider = new FakeCloudflaredProvider();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [provider],
        reconcileDelayMs: 60_000,
    });
    try {
        await runtime.upsert({
            enabled: true,
            id: "cloudflare-mcp",
            provider: "cloudflared",
            target: "mcp",
            token: "tunnel-token",
        });
        assert.equal(
            config.values.get("mcp.publicBaseUrl"),
            "http://127.0.0.1:47123",
        );

        provider.sessions[0]!.setPublicUrl("https://auto.example.test/");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
            config.values.get("mcp.publicBaseUrl"),
            "https://auto.example.test/",
        );

        await config.update({
            "mcp.publicBaseUrl": "https://manual.example.test/",
        });
        provider.sessions[0]!.setPublicUrl("https://changed.example.test/");
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
            config.values.get("mcp.publicBaseUrl"),
            "https://manual.example.test/",
        );
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessRuntime never starts a replacement tunnel while the previous session failed to stop", async () => {
    const directory = await createTestTempDirectory("access-runtime-stop-failure");
    const config = new MemoryConfig();
    const provider = new FakeSshProvider();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [provider],
        reconcileDelayMs: 60_000,
    });
    try {
        await runtime.upsert(sshEndpoint);
        const first = provider.sessions[0]!;
        first.stopFailure = new Error("stop blocked");

        await config.update({ "mcp.listenPort": 49123 });
        await runtime.reconcile();
        assert.equal(provider.opens.length, 1);
        assert.equal(runtime.get("ssh-main")?.state, "error");
        assert.match(runtime.get("ssh-main")?.error ?? "", /stop blocked/u);

        first.stopFailure = undefined;
        await runtime.reconcile();
        assert.equal(provider.opens.length, 2);
        assert.equal(first.stops, 2);
        assert.equal(
            provider.opens[1]?.target.origin.href,
            "http://127.0.0.1:49123/",
        );
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

test("AccessRuntime keeps the earliest retry deadline across endpoints", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const directory = await createTestTempDirectory("access-runtime-retry-deadline");
    const config = new MemoryConfig();
    await config.update({
        "access.endpoints": [
            { ...sshEndpoint, id: "slow-failure" },
            { ...sshEndpoint, id: "fast-recovery" },
        ],
    });
    const provider = new SelectiveFailSshProvider();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [provider],
        reconcileDelayMs: 60_000,
    });
    try {
        for (let attempt = 0; attempt < 6; attempt += 1)
            await runtime.reconcile();
        assert.equal(
            provider.opens.filter(
                (input) => input.endpoint.id === "slow-failure",
            ).length,
            6,
        );
        assert.equal(provider.sessions.get("fast-recovery")?.length, 1);

        provider.sessions.get("fast-recovery")?.[0]?.closeUnexpectedly();
        await Promise.resolve();
        await Promise.resolve();
        t.mock.timers.tick(999);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(provider.sessions.get("fast-recovery")?.length, 1);

        t.mock.timers.tick(1);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(
            provider.sessions.get("fast-recovery")?.length,
            2,
            "the 1s retry must preempt the existing 30s retry deadline",
        );
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

test("Access CLI restricts mutations to the local owner and exposes runtime status", async () => {
    const abort = new AbortController();
    const remote = {
        localOwner: false,
        requestId: "remote",
        signal: abort.signal,
    };
    await assert.rejects(
        async () =>
            await executeAccessCommand(
                {} as AccessRuntime,
                ["set", JSON.stringify(sshEndpoint)],
                remote,
            ),
        /local owner/u,
    );

    const fake = {
        list: () => [
            {
                enabled: true,
                id: "demo",
                provider: "ssh",
                state: "running",
                target: "mcp",
            },
        ],
    } as unknown as AccessRuntime;
    assert.deepEqual(await executeAccessCommand(fake, ["list"], remote), {
        kind: "json",
        value: [
            {
                enabled: true,
                id: "demo",
                provider: "ssh",
                state: "running",
                target: "mcp",
            },
        ],
    });
});

test("Access CLI configures Cloudflare from one interactive tunnel token", async () => {
    let configured: ExtensionJsonValue | undefined;
    let rawRequested = false;
    let stderr = "";
    const fake = {
        async upsert(value: ExtensionJsonValue) {
            configured = value;
            return {
                enabled: true,
                id: "cloudflare-mcp",
                origin: "http://127.0.0.1:47123/",
                provider: "cloudflared",
                state: "running",
                target: "mcp",
            };
        },
    } as unknown as AccessRuntime;
    const chunks = [Buffer.from("secret-tunnel-token\r")];
    const local = {
        io: {
            async readInput() {
                return chunks.shift();
            },
            async requestInput(options?: { raw?: boolean }) {
                rawRequested = options?.raw === true;
            },
            async writeStderr(chunk: string) {
                stderr += chunk;
            },
            async writeStdout() {},
        },
        localOwner: true,
        requestId: "local",
        signal: new AbortController().signal,
    };

    const result = await executeAccessCommand(fake, ["cloudflare"], local);
    assert.equal(rawRequested, true);
    assert.equal(stderr, "Cloudflare tunnel token: \n");
    assert.deepEqual(configured, {
        enabled: true,
        id: "cloudflare-mcp",
        provider: "cloudflared",
        target: "mcp",
        token: "secret-tunnel-token",
    });
    assert.equal(result.kind, "text");
    if (result.kind !== "text") assert.fail("text result expected");
    assert.match(result.text, /Service URL: http:\/\/127\.0\.0\.1:47123\//u);
    assert.match(result.text, /Published application route/u);
    assert.doesNotMatch(result.text, /secret-tunnel-token/u);
});

test("Access CLI configures SSH reverse interactively", async () => {
    let configured: ExtensionJsonValue | undefined;
    let stderr = "";
    const fake = {
        async upsert(value: ExtensionJsonValue) {
            configured = value;
            return {
                enabled: true,
                id: "ssh-mcp",
                origin: "http://127.0.0.1:47123/",
                provider: "ssh",
                publicUrl: "https://mcp.example.test/",
                state: "running",
                target: "mcp",
            };
        },
    } as unknown as AccessRuntime;
    const chunks = [
        Buffer.from("gateway.example.test\r"),
        Buffer.from("aromatic\r"),
        Buffer.from("\r"),
        Buffer.from("\r"),
        Buffer.from("17890\r"),
        Buffer.from("https://mcp.example.test\r"),
    ];
    const local = {
        io: {
            async readInput() {
                return chunks.shift();
            },
            async requestInput() {},
            async writeStderr(chunk: string) {
                stderr += chunk;
            },
            async writeStdout() {},
        },
        localOwner: true,
        requestId: "local",
        signal: new AbortController().signal,
    };

    const result = await executeAccessCommand(fake, ["ssh"], local);
    assert.deepEqual(configured, {
        enabled: true,
        host: "gateway.example.test",
        id: "ssh-mcp",
        port: 22,
        provider: "ssh",
        publicUrl: "https://mcp.example.test",
        remoteBindHost: "127.0.0.1",
        remotePort: 17890,
        target: "mcp",
        user: "aromatic",
    });
    assert.match(stderr, /SSH host:/u);
    assert.match(stderr, /Remote MCP port:/u);
    assert.equal(result.kind, "text");
    if (result.kind !== "text") assert.fail("text result expected");
    assert.match(result.text, /SSH reverse access configured\./u);
    assert.match(result.text, /https:\/\/mcp\.example\.test\//u);
});

test("Access Web endpoint serves status behind the host Web application gateway", async () => {
    const directory = await createTestTempDirectory("access-web");
    const config = new MemoryConfig();
    const runtime = new AccessRuntime(context(directory, config), {
        providers: [new FakeSshProvider()],
        reconcileDelayMs: 60_000,
    });
    try {
        const upstream = await runtime.webUpstream();
        const response = await fetch(new URL("api/status", upstream));
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), []);
        const html = await fetch(upstream);
        assert.equal(html.status, 200);
        assert.match(await html.text(), /Managed remote access endpoints/u);
    } finally {
        await runtime.dispose();
        await rm(directory, { force: true, recursive: true });
    }
});

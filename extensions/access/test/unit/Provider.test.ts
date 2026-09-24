import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import type {
    ExtensionJsonValue,
    ExtensionManagedProcess,
    ExtensionProcessExit,
    ExtensionProcessStartInput,
} from "@portable-devshell/extension";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { AccessBinaryManager } from "../../src/builtin/binary/AccessBinaryManager.ts";
import { CloudflaredProvider } from "../../src/builtin/provider/CloudflaredProvider.ts";
import { FrpProvider, renderFrpConfig } from "../../src/builtin/provider/FrpProvider.ts";
import { buildSshArgs, SshReverseProvider } from "../../src/builtin/provider/SshReverseProvider.ts";
import type { FrpAccessEndpoint, SshAccessEndpoint } from "../../src/builtin/Config.ts";

class FakeProcess implements ExtensionManagedProcess {
    readonly closed: Promise<ExtensionProcessExit>;
    readonly #message = new Set<(message: ExtensionJsonValue) => void>();
    readonly #stderr = new Set<(chunk: string) => void>();
    readonly #stdout = new Set<(chunk: string) => void>();
    #resolve!: (exit: ExtensionProcessExit) => void;

    constructor() {
        this.closed = new Promise((resolve) => {
            this.#resolve = resolve;
        });
    }

    emitStderr(chunk: string): void {
        for (const listener of this.#stderr) listener(chunk);
    }
    onMessage(listener: (message: ExtensionJsonValue) => void): () => void {
        this.#message.add(listener);
        return () => this.#message.delete(listener);
    }
    onStderr(listener: (chunk: string) => void): () => void {
        this.#stderr.add(listener);
        return () => this.#stderr.delete(listener);
    }
    onStdout(listener: (chunk: string) => void): () => void {
        this.#stdout.add(listener);
        return () => this.#stdout.delete(listener);
    }
    async send(): Promise<void> {}
    async terminate(): Promise<void> {
        this.#resolve({ signal: "SIGTERM" });
    }
}

function processContext(directory: string) {
    const starts: ExtensionProcessStartInput[] = [];
    const processes: FakeProcess[] = [];
    return {
        context: {
            dataDirectory: directory,
            processes: {
                async start(input: ExtensionProcessStartInput) {
                    starts.push(input);
                    const process = new FakeProcess();
                    processes.push(process);
                    return process;
                },
            },
            runtimeDirectory: directory,
        },
        processes,
        starts,
    };
}

test("cloudflared provider targets the local service and discovers a quick tunnel URL", async () => {
    const directory = await createTestTempDirectory("access-cloudflared");
    try {
        const harness = processContext(directory);
        const provider = new CloudflaredProvider(
            harness.context,
            new AccessBinaryManager(directory),
        );
        const session = await provider.open({
            endpoint: {
                binary: "/opt/cloudflared",
                enabled: true,
                id: "quick",
                provider: "cloudflared",
                target: "web",
            },
            target: { kind: "web", origin: new URL("http://127.0.0.1:9000/") },
        });
        assert.deepEqual(harness.starts[0], {
            args: [
                "tunnel",
                "--no-autoupdate",
                "--url",
                "http://127.0.0.1:9000/",
            ],
            command: "/opt/cloudflared",
        });
        harness.processes[0]!.emitStderr(
            "INF Your quick Tunnel has been created! Visit it at https://random-",
        );
        harness.processes[0]!.emitStderr("name.trycloudflare.com");
        assert.equal(session.publicUrl(), "https://random-name.trycloudflare.com");
        await session.stop();
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

test("FRP and SSH providers render the expected reverse forwarding targets", async () => {
    const frp: FrpAccessEndpoint = {
        binary: "/opt/frpc",
        enabled: true,
        id: "frp-main",
        provider: "frp",
        publicUrl: "https://frp.example.test/",
        remotePort: 9443,
        serverHost: "frp.example.test",
        serverPort: 7001,
        target: "mcp",
        token: "secret",
    };
    assert.match(renderFrpConfig(frp, new URL("http://127.0.0.1:8080/")), /serverAddr = "frp\.example\.test"/u);
    assert.match(renderFrpConfig(frp, new URL("http://127.0.0.1:8080/")), /remotePort = 9443/u);

    const ssh: SshAccessEndpoint = {
        binary: "/usr/bin/ssh",
        enabled: true,
        host: "gateway.example.test",
        id: "ssh-main",
        identityFile: "/keys/id_ed25519",
        port: 2222,
        provider: "ssh",
        remoteBindHost: "0.0.0.0",
        remotePort: 9443,
        target: "web",
        user: "devshell",
    };
    assert.deepEqual(buildSshArgs(ssh, new URL("http://127.0.0.1:8081/")), [
        "-N",
        "-T",
        "-o",
        "ExitOnForwardFailure=yes",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ServerAliveCountMax=3",
        "-p",
        "2222",
        "-i",
        "/keys/id_ed25519",
        "-R",
        "0.0.0.0:9443:127.0.0.1:8081",
        "devshell@gateway.example.test",
    ]);

    const directory = await createTestTempDirectory("access-frp");
    try {
        const harness = processContext(directory);
        const provider = new FrpProvider(
            harness.context,
            new AccessBinaryManager(directory),
        );
        const session = await provider.open({
            endpoint: frp,
            target: { kind: "mcp", origin: new URL("http://127.0.0.1:8080/") },
        });
        assert.equal(harness.starts[0]?.command, "/opt/frpc");
        const configPath = harness.starts[0]?.args?.[1];
        assert.ok(configPath);
        assert.match(await readFile(configPath, "utf8"), /localPort = 8080/u);
        await session.stop();

        const sshHarness = processContext(directory);
        const sshProvider = new SshReverseProvider(
            sshHarness.context,
            new AccessBinaryManager(directory),
        );
        const sshSession = await sshProvider.open({
            endpoint: ssh,
            target: { kind: "web", origin: new URL("http://127.0.0.1:8081/") },
        });
        assert.deepEqual(sshHarness.starts[0]?.args, buildSshArgs(ssh, new URL("http://127.0.0.1:8081/")));
        await sshSession.stop();
    } finally {
        await rm(directory, { force: true, recursive: true });
    }
});

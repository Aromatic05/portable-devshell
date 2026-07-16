import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
    Channel,
    Codec,
    PrefixRoute,
    asInstanceName,
    createError,
    type Destination,
    type Event,
    type JsonValue
} from "@portable-devshell/shared";

import { ControlServer } from "../../dist/control/ControlServer.js";
import {
    ControlConfigTomlCodec,
    ControlInstanceTomlCodec
} from "../../dist/modules/config/config/codec/ConfigTomlCodec.js";
import { ControlPathHome } from "@portable-devshell/shared";
import { ReverseCredentialStore } from "../../dist/modules/reverse/ReverseCredentialStore.js";

test("real Rust reverse worker connects to the TS gateway and executes a tool call", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-reverse-real-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-reverse-real-runtime-"));
    const workspace = await mkdtemp(join(tmpdir(), "portable-devshell-reverse-real-workspace-"));
    const port = await reservePort();
    const publicBaseUrl = `http://127.0.0.1:${port}`;
    const paths = new ControlPathHome(homeDirectory);
    const workerBinary = resolve(
        fileURLToPath(new URL("../../../../", import.meta.url)),
        "target/debug/devshell-worker"
    );
    const server = new ControlServer({ homeDirectory, xdgRuntimeDir });
    const workerRef: { value?: ChildProcessWithoutNullStreams } = {};
    let workerStdout = "";
    let workerStderr = "";

    await mkdir(paths.controlHomeDir, { recursive: true });
    await mkdir(paths.instancesDir, { recursive: true });
    await writeFile(
        paths.configFile,
        new ControlConfigTomlCodec().encode({
            control: { logLevel: "info" },
            instances: [],
            mcp: {
                auth: { mode: "none" },
                enabled: true,
                listenHost: "127.0.0.1",
                listenPort: port,
                publicBaseUrl
            },
            version: 1
        }),
        "utf8"
    );
    await writeFile(
        paths.instanceConfigFile("reverse-test"),
        new ControlInstanceTomlCodec().encode({
            enabled: true,
            logs: { eventBufferSize: 50 },
            mcp: {
                enabled: true,
                tools: { capabilities: ["read", "write", "execute"], groups: ["bash"] }
            },
            name: "reverse-test",
            provider: "reverse",
            workspace
        }),
        "utf8"
    );

    const credentialStore = new ReverseCredentialStore(homeDirectory);
    const code = await credentialStore.createDeviceCode("reverse-test");
    const credential = await credentialStore.consumeDeviceCode(code.deviceCode);
    const workerHome = join(homeDirectory, ".devshell", "reverse-test");
    await mkdir(join(workerHome, "state"), { recursive: true });
    await mkdir(join(workerHome, "logs"), { recursive: true });
    await mkdir(join(workerHome, "artifacts"), { recursive: true });
    await writeFile(
        join(workerHome, "config.toml"),
        [
            "version = 1",
            'instance = "reverse-test"',
            `createdAt = ${Math.floor(Date.now() / 1000)}`,
            "",
            "[reverse]",
            `controllerUrl = ${JSON.stringify(publicBaseUrl)}`,
            `deviceToken = ${JSON.stringify(credential.deviceToken)}`,
            "generation = 0",
            ""
        ].join("\n"),
        { encoding: "utf8", mode: 0o600 }
    );

    t.after(async () => {
        workerRef.value?.kill("SIGTERM");
        await server.stop().catch(() => undefined);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspace, { force: true, recursive: true });
    });

    await server.start();
    const worker = spawn(workerBinary, [], {
        env: {
            ...process.env,
            DEVSHELL_WORKER_INTERNAL_INSTANCE: "reverse-test",
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "disabled",
            DEVSHELL_WORKER_INTERNAL_WORKSPACE: workspace,
            HOME: homeDirectory,
            XDG_RUNTIME_DIR: xdgRuntimeDir
        },
        stdio: ["pipe", "pipe", "pipe"]
    });
    workerRef.value = worker;
    worker.stdout.setEncoding("utf8");
    worker.stderr.setEncoding("utf8");
    worker.stdout.on("data", (chunk: string) => {
        workerStdout += chunk;
    });
    worker.stderr.on("data", (chunk: string) => {
        workerStderr += chunk;
    });

    await waitUntil(async () => {
        const snapshot = await request(
            server.socketPath,
            "runtime.snapshot",
            asInstanceName("reverse-test")
        );
        return snapshot.snapshot.ready === true && snapshot.snapshot.reverse?.transport === "wss";
    }, () => `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`);

    const result = await request(
        server.socketPath,
        "tool.call",
        asInstanceName("reverse-test"),
        { input: { command: "pwd && printf ' reverse-real-worker'" }, toolName: "bash_run" }
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /reverse-real-worker/u);
    assert.match(result.stdout, new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

    const stopped = await request(
        server.socketPath,
        "runtime.stop",
        asInstanceName("reverse-test")
    );
    assert.equal(stopped.ready, false);
    await waitForExit(worker);
});

async function reservePort(): Promise<number> {
    const server = createServer();
    await new Promise<void>((resolvePromise, rejectPromise) => {
        server.once("error", rejectPromise);
        server.listen(0, "127.0.0.1", resolvePromise);
    });
    const address = server.address();
    assert.equal(typeof address, "object");
    assert.notEqual(address, null);
    const port = (address as { port: number }).port;
    await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error === undefined ? resolvePromise() : rejectPromise(error)));
    });
    return port;
}

async function waitUntil(
    predicate: () => Promise<boolean>,
    diagnostic: () => string,
    timeoutMs = 15_000
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
        try {
            if (await predicate()) {
                return;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
    }
    throw new Error(
        `Condition was not reached.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}\n${diagnostic()}`
    );
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(() => rejectPromise(new Error("reverse worker did not exit")), 5_000);
        child.once("exit", () => {
            clearTimeout(timeout);
            resolvePromise();
        });
    });
}

async function request(
    socketPath: string,
    operation: Event["name"],
    destination: Destination,
    params?: JsonValue
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const route = new PrefixRoute(
        new Codec(await Channel.connect(socketPath), { local: "cli", remote: "server" }),
        { requestIdPrefix: "cli" }
    );
    try {
        const reply = await route.request({
            destination,
            name: operation,
            ...(params === undefined ? {} : { payload: params })
        });
        if (reply.event.error !== undefined) {
            throw createError(reply.event.error);
        }
        return reply.event.payload;
    } finally {
        route.close();
    }
}

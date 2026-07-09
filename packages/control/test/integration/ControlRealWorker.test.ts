import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { ControlLifecycleManager } from "../../dist/control/ControlLifecycleManager.js";
import { ControlInstanceTomlCodec } from "../../dist/control/config/ControlConfigTomlCodec.js";
import { ControlConfigTomlCodec } from "../../dist/control/config/ControlConfigTomlCodec.js";
import { ControlPathHome } from "../../dist/control/path/ControlPathHome.js";
import { ControlPathRuntime } from "../../dist/control/path/ControlPathRuntime.js";

test("control lifecycle smoke drives the frozen worker and persists Task 12 artifacts", async (t) => {
    const homeDirectory = await mkdtemp(join(tmpdir(), "portable-devshell-control-real-home-"));
    const xdgRuntimeDir = await mkdtemp(join(tmpdir(), "portable-devshell-control-real-runtime-"));
    const workspacePath = await mkdtemp(join(tmpdir(), "portable-devshell-control-real-workspace-"));
    const workerBinaryPath = resolve(fileURLToPath(new URL("../../../../", import.meta.url)), "target/debug/devshell-worker");
    const workerEnvName = hostWorkerEnvName();
    const previousWorkerPath = process.env[workerEnvName];
    const homePaths = new ControlPathHome(homeDirectory);
    const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
    const manager = new ControlLifecycleManager({
        homeDirectory,
        xdgRuntimeDir,
        waitTimeoutMs: 10_000
    });

    process.env[workerEnvName] = workerBinaryPath;

    await mkdir(homePaths.controlHomeDir, { recursive: true });
    await mkdir(homePaths.instancesDir, { recursive: true });
    await writeFile(homePaths.configFile, new ControlConfigTomlCodec().encode(createGlobalConfig()), "utf8");
    await writeFile(
        homePaths.instanceConfigFile("aromatic-pc"),
        new ControlInstanceTomlCodec().encode(createInstanceConfig(workspacePath)),
        "utf8"
    );

    t.after(async () => {
        await manager.stop().catch(() => undefined);
        restoreEnv(workerEnvName, previousWorkerPath);
        await rm(homeDirectory, { force: true, recursive: true });
        await rm(xdgRuntimeDir, { force: true, recursive: true });
        await rm(workspacePath, { force: true, recursive: true });
    });

    const started = await manager.start();
    assert.equal(started.running, true);
    assert.equal(started.instanceCount, 1);

    const listed = await request(runtimePaths.socketFile, "control.listInstances", { kind: "control" });
    assert.equal(Array.isArray(listed), true);
    assert.equal(listed[0]?.name, "aromatic-pc");
    assert.equal(listed[0]?.snapshot.ready, false);
    assert.equal(listed[0]?.snapshot.daemonState, "stopped");

    const instanceStarted = await request(runtimePaths.socketFile, "instance.start", { instance: "aromatic-pc", kind: "instance" });
    assert.equal(instanceStarted.ready, true);

    const snapshot = await request(runtimePaths.socketFile, "instance.getSnapshot", { instance: "aromatic-pc", kind: "instance" });
    assert.equal(snapshot.snapshot.ready, true);
    assert.equal(snapshot.snapshot.name, "aromatic-pc");
    assert.ok(snapshot.lastSeq >= 1);

    const toolCall = await request(
        runtimePaths.socketFile,
        "instance.callTool",
        { instance: "aromatic-pc", kind: "instance" },
        { input: { command: "pwd && printf ' portable-devshell-control'" }, toolName: "bash_run" }
    );
    assert.equal(toolCall.exitCode, 0);
    assert.match(toolCall.stdout, new RegExp(workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(toolCall.stdout, /portable-devshell-control/u);

    const logs = await request(
        runtimePaths.socketFile,
        "instance.readLogs",
        { instance: "aromatic-pc", kind: "instance" },
        { fromSeq: 1 }
    );
    assert.equal(Array.isArray(logs), true);
    assert.match(logs.map((entry: { message: string }) => entry.message).join("\n"), /portable-devshell-control/u);

    const instanceStopped = await request(runtimePaths.socketFile, "instance.stop", { instance: "aromatic-pc", kind: "instance" });
    assert.equal(instanceStopped.ready, false);

    assert.match(await readFile(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "tool-calls.jsonl"), "utf8"), /bash_run/u);
    assert.match(await readFile(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "events.jsonl"), "utf8"), /toolCall\.completed/u);
    assert.match(await readFile(join(homeDirectory, ".devshell", "aromatic-pc", "control-worker", "logs.jsonl"), "utf8"), /portable-devshell-control/u);
    assert.match(await readFile(join(homeDirectory, ".devshell", "control", "logs", "control.log"), "utf8"), /control server started/u);

    const stopped = await manager.stop();
    assert.equal(stopped.running, false);
});

function createGlobalConfig() {
    return {
        control: {
            logLevel: "info"
        },
        instances: [],
        mcp: {
            auth: {
                mode: "none" as const
            },
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 0
        },
        version: 1
    };
}

function createInstanceConfig(workspacePath: string) {
    return {
        enabled: true,
        logs: {
            eventBufferSize: 50
        },
        mcp: {
            allowTools: ["bash_run"],
            enabled: true
        },
        name: "aromatic-pc",
        provider: "local" as const,
        workspace: workspacePath
    };
}

function restoreEnv(name: keyof NodeJS.ProcessEnv, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

function hostWorkerEnvName(): keyof NodeJS.ProcessEnv {
    return `PORTABLE_DEVSHELL_WORKER_${normalizePlatform(process.platform)}_${normalizeArch(process.arch)}_PATH`;
}

function normalizePlatform(platform: NodeJS.Platform): string {
    switch (platform) {
        case "linux":
            return "LINUX";
        case "darwin":
            return "DARWIN";
        default:
            throw new Error(`unsupported platform in test: ${platform}`);
    }
}

function normalizeArch(arch: string): string {
    switch (arch) {
        case "x64":
            return "X64";
        case "arm64":
            return "ARM64";
        default:
            throw new Error(`unsupported architecture in test: ${arch}`);
    }
}

async function request(
    socketPath: string,
    method: string,
    target: { kind: "control" } | { instance: string; kind: "instance" },
    params?: JsonValue
): Promise<any> {
    const socket = createConnection(socketPath);
    const reader = new FrameReader();
    const writer = new FrameWriter(socket);

    await new Promise<void>((resolve, reject) => {
        socket.once("connect", resolve);
        socket.once("error", reject);
    });

    const response = new Promise<any>((resolve, reject) => {
        socket.on("data", (chunk: Uint8Array) => {
            for (const frame of reader.push(chunk)) {
                const envelope = frame as Record<string, any>;

                if (envelope.type !== "response") {
                    continue;
                }

                socket.destroy();

                if (envelope.ok !== true) {
                    reject(new Error(envelope.error?.message ?? "request failed"));
                    return;
                }

                resolve(envelope.result);
            }
        });
        socket.once("error", reject);
    });

    await writer.write({
        id: `${method}-${Date.now()}`,
        issuedAt: new Date().toISOString(),
        method,
        params,
        target,
        type: "request"
    } as unknown as JsonValue);

    return await response;
}

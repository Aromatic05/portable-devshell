import assert from "node:assert/strict";
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    asInstanceName,
    ClientConnection,
    createError,
    ControlLifecycleManager,
    ControlPathHome,
    ControlPathRuntime,
    type Destination,
    type ConfigInstanceDraft,
    type JsonValue,
} from "@portable-devshell/shared";

import { controlDaemonModulePath } from "../../src/testing.ts";
import {
    createTestWindowsIdentity,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
    workerPathEnvironmentName,
    workingDirectoryMarkerCommand,
} from "../../../../test/TestPlatformSupport.ts";
import {
    encodeGlobalConfig,
    encodeInstanceConfig,
} from "../ConfigTomlTestSupport.ts";

const workerBinaryPath = resolveTestWorkerBinary();

if (process.env.PORTABLE_DEVSHELL_REAL_WORKER_CHILD !== "1") {
    test(
        "control lifecycle smoke drives the frozen worker in an isolated process",
        realWorkerTestOptions(workerBinaryPath),
        async () => {
            await runIsolatedScenario();
        },
    );
} else {
    test(
        "control lifecycle smoke drives the frozen worker and persists Task 12 artifacts",
        realWorkerTestOptions(workerBinaryPath),
        async (t) => {
            const homeDirectory = await mkdtemp(
                join(tmpdir(), "portable-devshell-control-real-home-"),
            );
            const xdgRuntimeDir = await mkdtemp(
                join(tmpdir(), "portable-devshell-control-real-runtime-"),
            );
            const workspacePath = await mkdtemp(
                join(tmpdir(), "portable-devshell-control-real-workspace-"),
            );
            const workerEnvName = workerPathEnvironmentName();
            const previousWorkerPath = process.env[workerEnvName];
            const homePaths = new ControlPathHome(homeDirectory);
            const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
            const manager = new ControlLifecycleManager({
                daemonModulePath: controlDaemonModulePath(),
                homeDirectory,
                xdgRuntimeDir,
                waitTimeoutMs: 10_000,
            });

            process.env[workerEnvName] = workerBinaryPath!;

            await mkdir(homePaths.controlHomeDir, { recursive: true });
            await mkdir(homePaths.instancesDir, { recursive: true });
            await writeFile(
                homePaths.configFile,
                encodeGlobalConfig(createGlobalConfig()),
                "utf8",
            );
            await writeFile(
                homePaths.instanceConfigFile("aromatic-pc"),
                encodeInstanceConfig(createInstanceConfig(workspacePath)),
                "utf8",
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

            const listed = await request(
                runtimePaths.socketFile,
                "instance.list",
                "@control",
            );
            assert.equal(Array.isArray(listed), true);
            assert.equal(listed[0]?.name, "aromatic-pc");
            assert.equal(listed[0]?.snapshot.ready, false);
            assert.equal(listed[0]?.snapshot.daemonState, "stopped");

            const instanceStarted = await request(
                runtimePaths.socketFile,
                "runtime.start",
                asInstanceName("aromatic-pc"),
            );
            assert.equal(instanceStarted.ready, true);

            const snapshot = await request(
                runtimePaths.socketFile,
                "runtime.snapshot",
                asInstanceName("aromatic-pc"),
            );
            assert.equal(snapshot.snapshot.ready, true);
            assert.equal(snapshot.snapshot.name, "aromatic-pc");
            assert.ok(snapshot.lastSeq >= 1);

            const toolCall = await request(
                runtimePaths.socketFile,
                "tool.call",
                asInstanceName("aromatic-pc"),
                {
                    input: {
                        command: workingDirectoryMarkerCommand(
                            "portable-devshell-control",
                        ),
                    },
                    toolName: "bash_run",
                },
            );
            assert.equal(toolCall.exitCode, 0);
            assert.match(
                toolCall.stdout,
                new RegExp(
                    workspacePath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
                    "u",
                ),
            );
            assert.match(toolCall.stdout, /portable-devshell-control/u);

            const logs = await request(
                runtimePaths.socketFile,
                "runtime.readLogs",
                asInstanceName("aromatic-pc"),
                { fromSeq: 1 },
            );
            assert.equal(Array.isArray(logs), true);
            assert.match(
                logs
                    .map((entry: { message: string }) => entry.message)
                    .join("\n"),
                /portable-devshell-control/u,
            );

            const toolCalls = await request(
                runtimePaths.socketFile,
                "tool.listCalls",
                asInstanceName("aromatic-pc"),
                { limit: 1, status: "completed", toolName: "bash_run" },
            );
            assert.equal(Array.isArray(toolCalls), true);
            assert.equal(toolCalls[0]?.instance, "aromatic-pc");
            assert.equal(toolCalls[0]?.source, "cli");
            assert.equal(toolCalls[0]?.toolName, "bash_run");
            assert.match(toolCalls[0]?.inputSummary ?? "", /portable-devshell-control/u);
            assert.equal(typeof toolCalls[0]?.stdoutBytes, "number");
            assert.equal(toolCalls[0]?.termination, "exited");

            const instanceStopped = await request(
                runtimePaths.socketFile,
                "runtime.stop",
                asInstanceName("aromatic-pc"),
            );
            assert.equal(instanceStopped.ready, false);

            const auditDatabase = await stat(
                join(
                    homeDirectory,
                    ".devshell",
                    "aromatic-pc",
                    "control-worker",
                    "audit.sqlite3",
                ),
            );
            assert.equal(auditDatabase.size > 0, true);
            assert.match(
                await readFile(
                    join(
                        homeDirectory,
                        ".devshell",
                        "control",
                        "logs",
                        "control.log",
                    ),
                    "utf8",
                ),
                /control server started/u,
            );

            const stopped = await manager.stop();
            assert.equal(stopped.running, false);
        },
    );
}

async function runIsolatedScenario(): Promise<void> {
    const registerPath = fileURLToPath(
        new URL(
            "../../../mcp/test/RegisterWorkspacePackages.mjs",
            import.meta.url,
        ),
    );
    const testPath = fileURLToPath(import.meta.url);
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const childEnv: NodeJS.ProcessEnv = {
            ...process.env,
            PORTABLE_DEVSHELL_REAL_WORKER_CHILD: "1",
            ...(process.platform === "win32"
                ? { USERNAME: createTestWindowsIdentity("control-real-worker") }
                : {}),
        };
        delete childEnv.NODE_TEST_CONTEXT;
        const child = spawn(
            process.execPath,
            ["--import", "tsx", "--import", pathToFileURL(registerPath).href, "--test", testPath],
            {
                env: childEnv,
                stdio: ["ignore", "pipe", "pipe"],
            },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.once("error", rejectPromise);
        child.once("exit", (code, signal) => {
            if (code === 0) {
                resolvePromise();
                return;
            }
            rejectPromise(
                new Error(
                    `isolated real-worker scenario failed with code ${String(code)} signal ${String(signal)}\n${stdout}${stderr}`,
                ),
            );
        });
    });
}

function createGlobalConfig() {
    return {
        control: {
            logLevel: "info",
        },
        mcp: {
            auth: {
                mode: "none" as const,
            },
            enabled: true,
            listenHost: "127.0.0.1",
            listenPort: 0,
        },
    };
}

function createInstanceConfig(workspacePath: string): ConfigInstanceDraft {
    return {
        enabled: true,
        logs: {
            eventBufferSize: 50,
            maxBytes: 16 * 1024 * 1024,
            retentionDays: 7,
        },
        mcp: {
            enabled: true,
            tools: {
                capabilities: ["read", "write", "execute"],
                groups: ["file", "bash", "artifact"],
            },
        },
        name: "aromatic-pc",
        provider: "local" as const,
        workspace: workspacePath,
    };
}

function restoreEnv(
    name: keyof NodeJS.ProcessEnv,
    value: string | undefined,
): void {
    if (value === undefined) {
        delete process.env[name];
        return;
    }

    process.env[name] = value;
}

async function request(
    socketPath: string,
    operation: string,
    destination: Destination,
    params?: JsonValue,
    clientKind: "cli" | "tui" = "cli",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const [module, method] = operation.split(".");
    const client = new ClientConnection({
        mapError: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        peer: clientKind,
        socketPath,
    });
    if (operation === "runtime.start") {
        const opened = await client.openStream(
            destination,
            module!,
            method!,
            params,
        );
        try {
            while (true) {
                const event = await opened.stream.nextEvent();
                if (event.name === "stream.completed") {
                    return event.payload;
                }
                if (event.name === "stream.cancelled") {
                    throw createError(
                        event.error ?? {
                            code: "control.requestFailed",
                            message: "runtime.start was cancelled",
                            retryable: false,
                        },
                    );
                }
            }
        } finally {
            opened.stream.close();
        }
    }

    return await client.request(destination, module!, method!, params);
}

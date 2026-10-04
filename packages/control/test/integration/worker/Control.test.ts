import assert from "node:assert/strict";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
    CONTROL_PROTOCOL_RANGE,
    Endpoint,
    LocalChannel,
    Rpc,
    Stream,
    asInstanceName,
    ControlLifecycleManager,
    ControlPathHome,
    ControlPathRuntime,
    type ConfigInstanceDraft,
    type ControlStreamMessage,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";

import { controlDaemonModulePath } from "../../../src/testing.ts";
import { CONTROL_BUILTIN_EXTENSION_SOURCES_ENV } from "../../../src/extension/install/BuiltinSource.ts";
import {
    createTestWindowsIdentity,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
    workerPathEnvironmentName,
    readRelativeMarkerCommand,
    terminalPrintCommand,
} from "../../../../../test/TestPlatformSupport.ts";
import {
    encodeGlobalConfig,
    encodeInstanceConfig,
} from "../../unit/control/config/persistence/Support.ts";
import { createCursorPositionResponder } from "../../support/TerminalProtocol.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";

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
            const homeDirectory =
                await createTestTempDirectory("control-real-home");
            const xdgRuntimeDir = await createTestTempDirectory(
                "control-real-runtime",
            );
            const workspacePath = await createTestTempDirectory(
                "control-real-workspace",
            );
            const workspaceMarkerName = "control-real-workspace-marker.txt";
            const workspaceMarker = "portable-devshell-control-workspace";
            await writeFile(
                join(workspacePath, workspaceMarkerName),
                workspaceMarker,
                "utf8",
            );
            const workerEnvName = workerPathEnvironmentName();
            const previousWorkerPath = process.env[workerEnvName];
            const homePaths = new ControlPathHome(homeDirectory);
            const runtimePaths = new ControlPathRuntime(xdgRuntimeDir);
            const manager = new ControlLifecycleManager({
                daemonModulePath: controlDaemonModulePath(),
                env: {
                    [CONTROL_BUILTIN_EXTENSION_SOURCES_ENV]: "[]",
                },
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
                encodeInstanceConfig(createInstanceConfig()),
                "utf8",
            );

            t.after(async () => {
                await manager.stop();
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
                "instance.listInstances",
                "@control",
            );
            assert.equal(Array.isArray(listed), true);
            assert.equal(listed[0]?.name, "aromatic-pc");
            assert.equal(listed[0]?.snapshot.ready, false);
            assert.equal(listed[0]?.snapshot.daemonState, "stopped");

            const instanceStarted = await request(
                runtimePaths.socketFile,
                "process.start",
                asInstanceName("aromatic-pc"),
            );
            assert.equal(instanceStarted.ready, true);

            const snapshot = await request(
                runtimePaths.socketFile,
                "process.snapshot",
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
                        command: readRelativeMarkerCommand(workspaceMarkerName),
                        timeoutMs: 30_000,
                    },
                    toolName: "bash_run",
                    workspace: workspacePath,
                },
            );
            assert.equal(toolCall.exitCode, 0);
            assert.match(toolCall.stdout, new RegExp(workspaceMarker, "u"));

            await exerciseWorkerTerminal(
                runtimePaths.socketFile,
                "aromatic-pc",
                workspacePath,
            );

            const logs = await request(
                runtimePaths.socketFile,
                "process.readLogs",
                asInstanceName("aromatic-pc"),
                { fromSeq: 1 },
            );
            assert.equal(Array.isArray(logs), true);
            assert.match(
                logs
                    .map((entry: { message: string }) => entry.message)
                    .join("\n"),
                /portable-devshell-control-workspace/u,
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
            assert.match(
                toolCalls[0]?.inputSummary ?? "",
                /control-real-workspace-marker\.txt/u,
            );
            assert.equal(typeof toolCalls[0]?.stdoutBytes, "number");
            assert.equal(toolCalls[0]?.termination, "exited");

            const instanceStopped = await request(
                runtimePaths.socketFile,
                "process.stop",
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
            "../../../../mcp/test/RegisterWorkspacePackages.mjs",
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
            [
                "--import",
                "tsx",
                "--import",
                pathToFileURL(registerPath).href,
                "--test",
                testPath,
            ],
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

function createInstanceConfig(): ConfigInstanceDraft {
    return {
        enabled: true,
        logs: {
            eventBufferSize: 50,
            maxBytes: 16 * 1024 * 1024,
            retentionDays: 7,
        },
        mcp: {
            enabled: true,
        },
        name: "aromatic-pc",
        provider: "local" as const,
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

async function exerciseWorkerTerminal(
    socketPath: string,
    instance: string,
    workspace: string,
): Promise<void> {
    const client = createClient(socketPath);
    try {
        await client.request("@control", "service", "hello", {
            clientKind: "tui",
            protocolRange: CONTROL_PROTOCOL_RANGE,
        });
        const opened = await client.request<{
            generation: number;
            terminalId: string;
            version: number;
        }>(asInstanceName(instance), "terminal", "open", {
            cols: 80,
            rows: 24,
            workspace,
        });
        const attached = await client.open(
            asInstanceName(instance),
            "terminal",
            "attach",
            {
                fromSeq: 0,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        try {
            assert.equal((await readStreamData(attached)).name, "seed");
            let clientSeq = 1;
            const cursorResponder = createCursorPositionResponder(
                async (data) => {
                    await attached.send({
                        name: "input",
                        payload: {
                            clientSeq: clientSeq++,
                            data,
                            generation: opened.generation,
                            terminalId: opened.terminalId,
                            version: opened.version,
                        },
                    });
                },
            );
            if (process.platform === "win32") {
                const bootstrapDeadline = Date.now() + 5_000;
                let responseCount = 0;
                while (responseCount === 0) {
                    if (Date.now() >= bootstrapDeadline)
                        throw new Error(
                            "terminal bootstrap cursor query timeout",
                        );
                    const event = await readStreamData(attached);
                    if (event.name === "output") {
                        const payload = event.payload as
                            { data?: string } | undefined;
                        responseCount += await cursorResponder.consume(
                            payload?.data ?? "",
                        );
                    }
                }
            }
            await attached.send({
                name: "input",
                payload: {
                    clientSeq: clientSeq++,
                    data: terminalPrintCommand("forward-worker-terminal-ready"),
                    generation: opened.generation,
                    terminalId: opened.terminalId,
                    version: opened.version,
                },
            });
            let output = "";
            let latestSeq = 0;
            const deadline = Date.now() + 5_000;
            while (!output.includes("forward-worker-terminal-ready")) {
                if (Date.now() >= deadline)
                    throw new Error(`terminal output timeout: ${output}`);
                const event = await readStreamData(attached);
                if (event.name === "output") {
                    const payload = event.payload as
                        { data?: string; seq?: number } | undefined;
                    const data = payload?.data ?? "";
                    output += data;
                    latestSeq = Math.max(latestSeq, payload?.seq ?? 0);
                    if (process.platform === "win32")
                        await cursorResponder.consume(data);
                }
            }
            if (latestSeq > 0)
                await attached.send({
                    name: "ack",
                    payload: {
                        generation: opened.generation,
                        terminalId: opened.terminalId,
                        throughSeq: latestSeq,
                        version: opened.version,
                    },
                });
            await client.request(
                asInstanceName(instance),
                "terminal",
                "kill",
                opened,
            );
        } finally {
            await attached.close();
        }
    } finally {
        client.close();
    }
}

interface TestClient {
    close(): void;
    open(
        host: string,
        port: string,
        name: string,
        payload?: JsonValue,
    ): Promise<MessageStream>;
    request<T = JsonValue>(
        host: string,
        port: string,
        operation: string,
        payload?: JsonValue,
    ): Promise<T>;
}

function createClient(socketPath: string): TestClient {
    const endpoint = new Endpoint({
        connectChannel: (signal) =>
            LocalChannel.connect(socketPath, { signal }),
    });
    const protocols: Array<Rpc | Stream> = [];
    const rpcs = new Map<string, Rpc>();
    return {
        close() {
            for (const protocol of protocols) protocol.close();
            endpoint.close();
        },
        async open(host, port, name, payload) {
            const protocol = new Stream(await endpoint.connect(host, port));
            protocols.push(protocol);
            return await protocol.open(name, payload);
        },
        async request<T = JsonValue>(
            host: string,
            port: string,
            operation: string,
            payload?: JsonValue,
        ) {
            const key = `${host}\u0000${port}`;
            let rpc = rpcs.get(key);
            if (rpc === undefined) {
                rpc = new Rpc(await endpoint.connect(host, port));
                rpcs.set(key, rpc);
                protocols.push(rpc);
            }
            return (await rpc.request(operation, payload)) as T;
        },
    };
}

async function readStreamData(
    stream: MessageStream,
): Promise<ControlStreamMessage> {
    const next = await stream.readMessage();
    assert.equal(next.type, "data");
    return next.message as ControlStreamMessage;
}

async function request(
    socketPath: string,
    operation: string,
    destination: string,
    params?: JsonValue,
    clientKind: "cli" | "tui" = "cli",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const [port, method] = operation.split(".");
    const client = createClient(socketPath);
    try {
        await client.request("@control", "service", "hello", {
            clientKind,
            protocolRange: CONTROL_PROTOCOL_RANGE,
        });
        if (operation === "process.start") {
            const stream = await client.open(
                destination,
                port!,
                method!,
                params,
            );
            try {
                while (true) {
                    const next = await stream.readMessage();
                    if (next.type === "close") return next.message;
                }
            } finally {
                await stream.close();
            }
        }
        return await client.request(destination, port!, method!, params);
    } finally {
        client.close();
    }
}

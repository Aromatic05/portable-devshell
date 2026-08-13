import assert from "node:assert/strict";
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
    asInstanceName,
    ClientConnection,
    createError,
    SocketChannel,
    type ClientEvent,
    type ClientStream,
    type Destination,
    type JsonValue,
} from "@portable-devshell/shared";

import { ControlServer } from "../../src/server/ControlServer.ts";
import { ControlPathHome } from "@portable-devshell/shared";
import { ReverseCredentialStore } from "../../src/control/reverse/credential/ReverseCredentialStore.ts";
import {
    encodeGlobalConfig,
    encodeInstanceConfig,
} from "../ConfigTomlTestSupport.ts";
import { createCursorPositionResponder } from "../TerminalProtocolTestSupport.ts";
import {
    installUniqueWindowsTestIdentity,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
    readRelativeMarkerCommand,
    terminalExpectedSize,
    terminalPrintCommand,
    terminalSizeProbeCommand,
} from "../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";
import { startLoopbackHttpProxy, type LoopbackHttpProxy } from "../../../../test/TestHttpSupport.ts";

const workerBinary = resolveTestWorkerBinary();
const execFileAsync = promisify(execFile);

test(
    "real Rust reverse worker connects to the TS gateway and executes a tool call",
    realWorkerTestOptions(workerBinary),
    async (t) => {
        const homeDirectory =
            await createTestTempDirectory("reverse-real-home");
        const xdgRuntimeDir = await createTestTempDirectory(
            "reverse-real-runtime",
        );
        const workspace = await createTestTempDirectory(
            "reverse-real-workspace",
        );
        const workspaceMarkerName = "reverse-real-workspace-marker.txt";
        const workspaceMarker = "portable-devshell-reverse-workspace";
        await writeFile(
            join(workspace, workspaceMarkerName),
            workspaceMarker,
            "utf8",
        );
        const proxy = await startLoopbackHttpProxy();
        const publicBaseUrl = proxy.origin;
        const restoreWindowsIdentity = installUniqueWindowsTestIdentity(
            "reverse-real-worker",
        );
        const paths = new ControlPathHome(homeDirectory);
        const server = new ControlServer({ homeDirectory, xdgRuntimeDir });
        const workerRef: { value?: ChildProcessWithoutNullStreams } = {};
        let workerStdout = "";
        let workerStderr = "";

        t.after(async () => {
            const worker = workerRef.value;
            if (worker !== undefined && worker.exitCode === null && worker.signalCode === null) {
                worker.kill("SIGTERM");
                await waitForExit(worker);
            }
            await server.stop();
            await proxy.close();
            restoreWindowsIdentity();
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(xdgRuntimeDir, { force: true, recursive: true });
            await rm(workspace, { force: true, recursive: true });
        });

        await mkdir(paths.controlHomeDir, { recursive: true });
        await mkdir(paths.instancesDir, { recursive: true });
        await writeFile(
            paths.configFile,
            encodeGlobalConfig({
                control: { logLevel: "info" },
                mcp: {
                    enabled: true,
                    listenHost: "127.0.0.1",
                    listenPort: 0,
                    publicBaseUrl,
                },
            }),
            "utf8",
        );
        await writeFile(
            paths.instanceConfigFile("reverse-test"),
            encodeInstanceConfig({
                enabled: true,
                logs: { eventBufferSize: 50 },
                mcp: {
                    enabled: true,
                    tools: {
                        capabilities: ["read", "write", "execute"],
                        groups: ["bash"],
                    },
                },
                name: "reverse-test",
                provider: "reverse",
            }),
            "utf8",
        );

        const credentialStore = new ReverseCredentialStore(homeDirectory);
        const code = await credentialStore.createDeviceCode("reverse-test");
        const credential = await credentialStore.consumeDeviceCode(
            code.deviceCode,
        );
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
                "",
            ].join("\n"),
            { encoding: "utf8", mode: 0o600 },
        );

        await server.start();
        await pointProxyAtControlMcp(proxy, server.socketPath);
        const worker = spawn(workerBinary!, [], {
            env: {
                ...process.env,
                DEVSHELL_WORKER_INTERNAL_INSTANCE: "reverse-test",
                DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: "disabled",
                HOME: homeDirectory,
                USERPROFILE: homeDirectory,
                XDG_RUNTIME_DIR: xdgRuntimeDir,
            },
            stdio: ["pipe", "pipe", "pipe"],
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

        await waitUntil(
            async () => {
                const snapshot = await request(
                    server.socketPath,
                    "runtime.snapshot",
                    asInstanceName("reverse-test"),
                );
                return (
                    snapshot.snapshot.ready === true &&
                    snapshot.snapshot.reverse?.transport === "wss"
                );
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );

        const result = await request(
            server.socketPath,
            "tool.call",
            asInstanceName("reverse-test"),
            {
                input: {
                    command: readRelativeMarkerCommand(workspaceMarkerName),
                },
                toolName: "bash_run",
                workspace,
            },
        );
        assert.equal(result.exitCode, 0);
        assert.match(result.stdout, new RegExp(workspaceMarker, "u"));

        const terminalClient = createClient(server.socketPath);
        t.after(() => terminalClient.close());
        await negotiateClient(terminalClient, "tui");
        const opened = await terminalClient.request<{
            generation: number;
            terminalId: string;
            version: number;
        }>(asInstanceName("reverse-test"), "terminal", "open", {
            cols: 80,
            rows: 24,
            workspace,
        });
        const attached = await terminalClient.openStream(
            asInstanceName("reverse-test"),
            "terminal",
            "attach",
            {
                fromSeq: 0,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        let outputSeq = 0;
        let terminalStream = attached.stream;
        let terminalVersion = opened.version;
        let terminalClientSeq = 1;
        let cursorResponseCount = 0;
        const cursorResponder = createCursorPositionResponder(async (data) => {
            await terminalStream.send("input", {
                clientSeq: terminalClientSeq++,
                data,
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            });
        });
        const observeTerminalProtocol = async (event: ClientEvent): Promise<void> => {
            if (process.platform !== "win32" || event.name !== "terminal.output") return;
            const payload = event.payload as { data?: string } | undefined;
            cursorResponseCount += await cursorResponder.consume(payload?.data ?? "");
        };
        if (process.platform === "win32") {
            await waitForTerminal(
                attached.stream,
                () => cursorResponseCount > 0,
                () => `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
                10_000,
                observeTerminalProtocol,
            );
        }
        const readyInputSeq = terminalClientSeq++;
        await attached.stream.send("input", {
            clientSeq: readyInputSeq,
            data: terminalPrintCommand("reverse-pty-ready"),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: terminalVersion,
        });
        let inputAccepted = false;
        const ready = await waitForTerminal(
            attached.stream,
            (event, output) => {
                if (
                    event.name === "terminal.inputAccepted" &&
                    (event.payload as { clientSeq?: number } | undefined)
                        ?.clientSeq === readyInputSeq
                ) {
                    inputAccepted = true;
                }
                return inputAccepted && output.includes("reverse-pty-ready");
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        outputSeq = Math.max(outputSeq, ready.lastOutputSeq);

        const resizeClientSeq = terminalClientSeq++;
        await attached.stream.send("resize", {
            clientSeq: resizeClientSeq,
            cols: 100,
            generation: opened.generation,
            rows: 40,
            terminalId: opened.terminalId,
            version: terminalVersion,
        });
        const resized = await waitForTerminal(
            attached.stream,
            (event) =>
                event.name === "terminal.resized" &&
                (event.payload as { clientSeq?: number } | undefined)
                    ?.clientSeq === resizeClientSeq,
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );
        terminalVersion = (resized.event.payload as { version: number }).version;
        if (process.platform === "win32") {
            cursorResponseCount += await cursorResponder.consume(resized.output);
        }
        const sizedInputSeq = terminalClientSeq++;
        await attached.stream.send("input", {
            clientSeq: sizedInputSeq,
            data: terminalSizeProbeCommand(),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: terminalVersion,
        });
        const sized = await waitForTerminal(
            attached.stream,
            (event, output) => {
                outputSeq = Math.max(outputSeq, terminalOutputSeq(event));
                return output.includes(terminalExpectedSize(40, 100));
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        outputSeq = Math.max(outputSeq, sized.lastOutputSeq);
        attached.stream.close();

        const resumed = await terminalClient.openStream(
            asInstanceName("reverse-test"),
            "terminal",
            "attach",
            {
                fromSeq: outputSeq,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        terminalStream = resumed.stream;
        const resumedInputSeq = terminalClientSeq++;
        await terminalStream.send("input", {
            clientSeq: resumedInputSeq,
            data: terminalPrintCommand("reverse-pty-resumed"),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: terminalVersion,
        });
        const resumedOutput = await waitForTerminal(
            terminalStream,
            (_event, output) => output.includes("reverse-pty-resumed"),
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        outputSeq = Math.max(outputSeq, resumedOutput.lastOutputSeq);
        const restartInputSeq = terminalClientSeq++;
        await terminalStream.send("input", {
            clientSeq: restartInputSeq,
            data: terminalPrintCommand("reverse-after-control-restart", 1_000),
            generation: opened.generation,
            terminalId: opened.terminalId,
            version: terminalVersion,
        });
        await waitForTerminal(
            terminalStream,
            (event) =>
                event.name === "terminal.inputAccepted" &&
                (event.payload as { clientSeq?: number } | undefined)
                    ?.clientSeq === restartInputSeq,
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        resumed.stream.close();
        terminalClient.close();

        await server.restart();
        await pointProxyAtControlMcp(proxy, server.socketPath);
        await waitUntil(
            async () => {
                const snapshot = await request(
                    server.socketPath,
                    "runtime.snapshot",
                    asInstanceName("reverse-test"),
                );
                return (
                    snapshot.snapshot.ready === true &&
                    snapshot.snapshot.reverse?.transport === "wss"
                );
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );

        const restartedClient = createClient(server.socketPath);
        t.after(() => restartedClient.close());
        await negotiateClient(restartedClient, "tui");
        const recovered = await restartedClient.openStream(
            asInstanceName("reverse-test"),
            "terminal",
            "attach",
            {
                fromSeq: outputSeq,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        terminalStream = recovered.stream;
        await waitForTerminal(
            terminalStream,
            (_event, output) =>
                output.includes("reverse-after-control-restart"),
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        recovered.stream.close();

        const killed = await restartedClient.request<{ state: string }>(
            asInstanceName("reverse-test"),
            "terminal",
            "kill",
            {
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        );
        assert.equal(killed.state, "killed");

        worker.kill("SIGTERM");
        await waitForExit(worker);
        await waitUntil(
            async () => {
                const snapshot = await request(
                    server.socketPath,
                    "runtime.snapshot",
                    asInstanceName("reverse-test"),
                );
                return (
                    snapshot.snapshot.ready === false &&
                    snapshot.snapshot.reverse?.availability === "offline"
                );
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );
    },
);

test(
    "real Rust reverse worker re-enrolls the same persistent instance and reuses the stored credential",
    realWorkerTestOptions(workerBinary),
    async (t) => {
        const controlHome = await createTestTempDirectory("reverse-reenroll-control");
        const controlRuntime = await createTestTempDirectory("reverse-reenroll-runtime");
        const workerHome = await createTestTempDirectory("reverse-reenroll-worker-home");
        const workerRuntime = await createTestTempDirectory("reverse-reenroll-worker-runtime");
        const workspace = await createTestTempDirectory("reverse-reenroll-workspace");
        const markerName = "reverse-reenroll-marker.txt";
        const marker = "reverse-reenroll-ok";
        await writeFile(join(workspace, markerName), marker, "utf8");
        const proxy = await startLoopbackHttpProxy();
        const publicBaseUrl = proxy.origin;
        const paths = new ControlPathHome(controlHome);
        const server = new ControlServer({
            homeDirectory: controlHome,
            xdgRuntimeDir: controlRuntime,
        });
        const workerEnvironment: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: workerHome,
            PORTABLE_DEVSHELL_HOME: join(workerHome, ".devshell"),
            USERPROFILE: workerHome,
            XDG_RUNTIME_DIR: workerRuntime,
        };
        delete workerEnvironment.DEVSHELL_WORKER_INTERNAL_INSTANCE;
        delete workerEnvironment.DEVSHELL_WORKER_INTERNAL_SECURITY_MODE;
        delete workerEnvironment.DEVSHELL_WORKER_INTERNAL_WORKSPACE;

        t.after(async () => {
            runWorkerCommand(
                ["stop", "--instance", "reverse-reenroll"],
                workerEnvironment,
                workspace,
                true,
            );
            await server.stop();
            await proxy.close();
            await Promise.all([
                rm(controlHome, { force: true, recursive: true }),
                rm(controlRuntime, { force: true, recursive: true }),
                rm(workerHome, { force: true, recursive: true }),
                rm(workerRuntime, { force: true, recursive: true }),
                rm(workspace, { force: true, recursive: true }),
            ]);
        });

        await mkdir(paths.controlHomeDir, { recursive: true });
        await mkdir(paths.instancesDir, { recursive: true });
        await writeFile(
            paths.configFile,
            encodeGlobalConfig({
                control: { logLevel: "info" },
                mcp: {
                    enabled: true,
                    listenHost: "127.0.0.1",
                    listenPort: 0,
                    publicBaseUrl,
                },
            }),
            "utf8",
        );
        await writeFile(
            paths.instanceConfigFile("reverse-reenroll"),
            encodeInstanceConfig({
                enabled: true,
                logs: { eventBufferSize: 50 },
                mcp: {
                    enabled: true,
                    tools: {
                        capabilities: ["read", "write", "execute"],
                        groups: ["bash"],
                    },
                },
                name: "reverse-reenroll",
                provider: "reverse",
            }),
            "utf8",
        );
        await server.start();
        await pointProxyAtControlMcp(proxy, server.socketPath);

        const enroll = async () => {
            const code = await new ReverseCredentialStore(controlHome).createDeviceCode(
                "reverse-reenroll",
            );
            const result = await execFileAsync(
                workerBinary!,
                [
                    "enroll",
                    "--controller",
                    publicBaseUrl,
                    "--device-code",
                    code.deviceCode,
                ],
                {
                    cwd: workspace,
                    encoding: "utf8",
                    env: workerEnvironment,
                    windowsHide: true,
                },
            );
            const parsed = JSON.parse(result.stdout) as {
                instance: string;
                started: boolean;
            };
            assert.equal(parsed.instance, "reverse-reenroll");
            assert.equal(parsed.started, true);
        };

        await enroll();
        const firstGeneration = await waitForReverseGeneration(
            server.socketPath,
            "reverse-reenroll",
        );
        await assertReverseMarker(server.socketPath, "reverse-reenroll", workspace, markerName, marker);

        await enroll();
        const secondGeneration = await waitForReverseGeneration(
            server.socketPath,
            "reverse-reenroll",
            firstGeneration,
        );
        await assertReverseMarker(server.socketPath, "reverse-reenroll", workspace, markerName, marker);

        runWorkerCommand(
            ["stop", "--instance", "reverse-reenroll"],
            workerEnvironment,
            workspace,
        );
        runWorkerCommand(
            ["start", "--instance", "reverse-reenroll"],
            workerEnvironment,
            workspace,
        );
        const restartedGeneration = await waitForReverseGeneration(
            server.socketPath,
            "reverse-reenroll",
            secondGeneration,
        );
        await assertReverseMarker(server.socketPath, "reverse-reenroll", workspace, markerName, marker);
    },
);

async function pointProxyAtControlMcp(proxy: LoopbackHttpProxy, socketPath: string): Promise<void> {
    const status = await request(socketPath, "mcp.status", "@control") as { listenAddress?: string };
    assert.equal(typeof status.listenAddress, "string");
    proxy.setTarget(`http://${status.listenAddress}`);
}

function runWorkerCommand(
    args: string[],
    environment: NodeJS.ProcessEnv,
    cwd: string,
    allowFailure = false,
) {
    const result = spawnSync(workerBinary!, args, {
        cwd,
        encoding: "utf8",
        env: environment,
        windowsHide: true,
    });
    if (result.error !== undefined) throw result.error;
    if (!allowFailure && result.status !== 0) {
        throw new Error(
            `worker ${args.join(" ")} failed (${result.status ?? "unknown"}): ${result.stderr || result.stdout}`,
        );
    }
    return result;
}

async function waitForReverseGeneration(
    socketPath: string,
    instance: string,
    greaterThan = 0,
): Promise<number> {
    let generation = 0;
    await waitUntil(
        async () => {
            const snapshot = await request(
                socketPath,
                "runtime.snapshot",
                asInstanceName(instance),
            );
            generation = snapshot.snapshot.reverse?.generation ?? 0;
            return snapshot.snapshot.ready === true && generation > greaterThan;
        },
        () => `reverse instance ${instance} did not become ready`,
    );
    return generation;
}

async function assertReverseMarker(
    socketPath: string,
    instance: string,
    workspace: string,
    markerName: string,
    expected: string,
): Promise<void> {
    const result = await request(
        socketPath,
        "tool.call",
        asInstanceName(instance),
        {
            input: { command: readRelativeMarkerCommand(markerName) },
            toolName: "bash_run",
            workspace,
        },
    );
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, new RegExp(expected, "u"));
}

async function waitUntil(
    predicate: () => Promise<boolean>,
    diagnostic: () => string,
    timeoutMs = 15_000,
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
        `Condition was not reached.${lastError instanceof Error ? ` Last error: ${lastError.message}` : ""}\n${diagnostic()}`,
    );
}

async function waitForExit(
    child: ChildProcessWithoutNullStreams,
): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return;
    }
    await new Promise<void>((resolvePromise, rejectPromise) => {
        const timeout = setTimeout(
            () => rejectPromise(new Error("reverse worker did not exit")),
            5_000,
        );
        child.once("exit", () => {
            clearTimeout(timeout);
            resolvePromise();
        });
    });
}

async function request(
    socketPath: string,
    operation: string,
    destination: Destination,
    params?: JsonValue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const [module, method] = operation.split(".");
    const client = new ClientConnection({
        connectChannel: (signal) => SocketChannel.connect(socketPath, { signal }),
        mapError: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "cli",
    });
    try {
        await negotiateClient(client, "cli");
        return await client.request(destination, module!, method!, params);
    } finally {
        client.close();
    }
}

function createClient(socketPath: string): ClientConnection {
    return new ClientConnection({
        connectChannel: (signal) => SocketChannel.connect(socketPath, { signal }),
        mapError: (error) =>
            error instanceof Error ? error : new Error(String(error)),
        mapRemoteError: (error) => createError(error),
        mode: "persistent",
        peer: "tui",
    });
}

async function negotiateClient(
    client: ClientConnection,
    clientKind: "cli" | "tui",
): Promise<void> {
    await client.request("@control", "service", "hello", {
        clientKind,
        maxProtocolVersion: 1,
        minProtocolVersion: 1,
    });
}

async function waitForTerminal(
    stream: ClientStream,
    predicate: (event: ClientEvent, output: string) => boolean,
    diagnostic: () => string,
    timeoutMs = 10_000,
    observe?: (event: ClientEvent) => Promise<void>,
): Promise<{ event: ClientEvent; lastOutputSeq: number; output: string }> {
    const deadline = Date.now() + timeoutMs;
    let output = "";
    let lastOutputSeq = 0;
    let lastEvent: ClientEvent | undefined;
    while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        let event: ClientEvent;
        try {
            event = await Promise.race([
                stream.nextEvent(),
                new Promise<never>((_, reject) =>
                    setTimeout(
                        () => reject(new Error("terminal event timeout")),
                        remaining,
                    ),
                ),
            ]);
        } catch (error) {
            throw new Error(
                [
                    `Terminal condition was not reached: ${error instanceof Error ? error.message : String(error)}`,
                    `Last event: ${lastEvent?.name ?? "none"}`,
                    `Output: ${JSON.stringify(output)}`,
                    diagnostic(),
                ].join("\n"),
            );
        }
        lastEvent = event;
        if (event.name === "terminal.output") {
            const payload = event.payload as
                { data?: string; seq?: number } | undefined;
            output += payload?.data ?? "";
            lastOutputSeq = Math.max(lastOutputSeq, payload?.seq ?? 0);
        }
        await observe?.(event);
        if (predicate(event, output)) {
            return { event, lastOutputSeq, output };
        }
    }
    throw new Error(
        `Terminal condition was not reached. Last event: ${lastEvent?.name ?? "none"}\n${diagnostic()}`,
    );
}

function terminalOutputSeq(event: ClientEvent): number {
    return event.name === "terminal.output"
        ? ((event.payload as { seq?: number } | undefined)?.seq ?? 0)
        : 0;
}

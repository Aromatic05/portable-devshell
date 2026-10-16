import assert from "node:assert/strict";
import {
    execFile,
    spawn,
    spawnSync,
    type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
    CONTROL_PROTOCOL_RANGE,
    Endpoint,
    LocalChannel,
    Rpc,
    Stream,
    asInstanceName,
    type ControlConfig,
    type ControlStreamMessage,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";

import { Control } from "../../../src/Control.ts";
import { ControlFactory } from "../../../src/Factory.ts";
import type { InstanceRegistry } from "../../../src/instance/Registry.ts";
import { ControlPathHome } from "@portable-devshell/shared";
import { ReverseCredentialStore } from "../../../src/instance/reverse/credential/Store.ts";
import {
    encodeGlobalConfig,
    encodeInstanceConfig,
} from "../../unit/control/config/persistence/Support.ts";
import { createCursorPositionResponder } from "../../support/TerminalProtocol.ts";
import {
    installUniqueWindowsTestIdentity,
    realWorkerTestOptions,
    resolveTestWorkerBinary,
    readRelativeMarkerCommand,
    terminalInputGatedPrintCommand,
    terminalExpectedSize,
    terminalPrintCommand,
    terminalSizeProbeCommand,
} from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import {
    startLoopbackHttpProxy,
    type LoopbackHttpProxy,
} from "../../../../../test/TestHttpSupport.ts";

const workerBinary = resolveTestWorkerBinary();
const execFileAsync = promisify(execFile);

class CapturingRuntimeFactory extends ControlFactory {
    registry?: InstanceRegistry;

    override async create(options: Parameters<ControlFactory["create"]>[0]) {
        this.registry = options.instances.registry;
        return await super.create(options);
    }
}

async function readServiceStream(stream: MessageStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) return Buffer.concat(chunks);
        chunks.push(Buffer.from(chunk));
    }
}

test(
    "worker enrollment reports pending instead of success when Reverse transport is unavailable",
    realWorkerTestOptions(workerBinary),
    async (t) => {
        const home = await createTestTempDirectory("reverse-enroll-pending");
        const runtime = await createTestTempDirectory("reverse-enroll-runtime");
        const environment: NodeJS.ProcessEnv = {
            ...process.env,
            HOME: home,
            PORTABLE_DEVSHELL_HOME: join(home, ".devshell"),
            USERPROFILE: home,
            XDG_RUNTIME_DIR: runtime,
        };
        delete environment.DEVSHELL_WORKER_INTERNAL_INSTANCE;
        const gateway = createHttpServer((request, response) => {
            if (request.method === "POST" && request.url === "/reverse/v1/enroll") {
                request.resume();
                response.writeHead(200, { "Content-Type": "application/json" });
                response.end(JSON.stringify({
                    controllerUrl: `http://127.0.0.1:${(gateway.address() as { port: number }).port}`,
                    deviceToken: "test-device-token",
                    instance: "reverse-pending",
                }));
                return;
            }
            response.writeHead(503);
            response.end("reverse transport unavailable");
        });
        gateway.listen(0, "127.0.0.1");
        await once(gateway, "listening");
        t.after(async () => {
            runWorkerCommand(
                ["stop", "--instance", "reverse-pending"],
                environment,
                home,
                true,
            );
            await new Promise<void>((resolve) => gateway.close(() => resolve()));
            await Promise.all([
                rm(home, { force: true, recursive: true }),
                rm(runtime, { force: true, recursive: true }),
            ]);
        });
        const controller = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
        const enrolled = await execFileAsync(
            workerBinary!,
            ["enroll", "--controller", controller, "--device-code", "ABCDE-FGHIJ"],
            { cwd: home, encoding: "utf8", env: environment, windowsHide: true },
        );
        const result = JSON.parse(enrolled.stdout) as {
            ok: boolean;
            started: boolean;
            connected: boolean;
            retrying: boolean;
        };
        assert.equal(result.ok, false);
        assert.equal(result.started, true);
        assert.equal(result.connected, false);
        assert.equal(result.retrying, true);
        assert.match(enrolled.stderr, /Reverse is reconnecting/u);
        const status = JSON.parse(runWorkerCommand(
            ["status", "--instance", "reverse-pending"],
            environment,
            home,
        ).stdout) as { running: boolean; reverse?: { state: string } };
        assert.equal(status.running, true);
        assert.equal(status.reverse?.state, "reconnecting");
    },
);

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
        const artifactSourceName = "reverse-artifact-source.bin";
        const artifactTargetName = "reverse-artifact-copy.bin";
        const artifactSource = Buffer.alloc(700 * 1024);
        for (let index = 0; index < artifactSource.length; index += 1) {
            artifactSource[index] = index % 251;
        }
        await writeFile(
            join(workspace, workspaceMarkerName),
            workspaceMarker,
            "utf8",
        );
        await writeFile(join(workspace, artifactSourceName), artifactSource);
        const proxy = await startLoopbackHttpProxy();
        const routeProxy = await startLoopbackHttpProxy();
        const publicBaseUrl = proxy.origin;
        const restoreWindowsIdentity = installUniqueWindowsTestIdentity(
            "reverse-real-worker",
        );
        const paths = new ControlPathHome(homeDirectory);
        const factory = new CapturingRuntimeFactory({ builtinExtensionSources: [] });
        const server = new Control({
            homeDirectory,
            factory,
            xdgRuntimeDir,
        });
        const workerRef: { value?: ChildProcessWithoutNullStreams } = {};
        let workerStdout = "";
        let workerStderr = "";

        t.after(async () => {
            const worker = workerRef.value;
            if (
                worker !== undefined &&
                worker.exitCode === null &&
                worker.signalCode === null
            ) {
                worker.kill("SIGTERM");
                await waitForExit(worker);
            }
            await server.stop();
            await routeProxy.close();
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
                `proxyUrl = ${JSON.stringify(routeProxy.origin)}`,
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
                    "process.snapshot",
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
                    timeoutMs: 30_000,
                },
                toolName: "bash_run",
                workspace,
            },
        );
        assert.equal(result.exitCode, 0, JSON.stringify(result));
        assert.match(result.stdout, new RegExp(workspaceMarker, "u"));

        const workerInstance = factory.registry?.get("reverse-test");
        assert.ok(workerInstance);
        const workerHost = `${workerInstance.config.name}-worker`;
        const httpBody = "reverse-http-over-devshell";
        const httpServer = createHttpServer((request, response) => {
            assert.equal(request.url, "/reverse-probe");
            response.writeHead(200, {
                Connection: "close",
                "Content-Length": Buffer.byteLength(httpBody),
                "Content-Type": "text/plain",
            });
            response.end(httpBody);
        });
        httpServer.listen(0, "127.0.0.1");
        await once(httpServer, "listening");
        t.after(() => httpServer.close());
        const httpAddress = httpServer.address();
        assert.ok(httpAddress !== null && typeof httpAddress !== "string");

        const networkProtocol = new Stream(
            await workerInstance.supervision.endpoint.connect(
                workerHost,
                "network",
            ),
        );
        t.after(() => networkProtocol.close());
        const tcp = await networkProtocol.open("tcp", {
            host: "127.0.0.1",
            port: httpAddress.port,
        });
        await tcp.write(
            Buffer.from(
                "GET /reverse-probe HTTP/1.1\r\nHost: devshell\r\nConnection: close\r\n\r\n",
            ),
        );
        await tcp.finish();
        const httpResponse = (await readServiceStream(tcp)).toString("utf8");
        assert.match(httpResponse, /^HTTP\/1\.1 200 OK\r\n/u);
        assert.match(httpResponse, /\r\n\r\nreverse-http-over-devshell$/u);

        const processProtocol = new Stream(
            await workerInstance.supervision.endpoint.connect(
                workerHost,
                "process",
            ),
        );
        t.after(() => processProtocol.close());
        const processStream = await processProtocol.open("exec", {
            executable: process.execPath,
            args: [
                "-e",
                "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(process.cwd()+'\\n'+input));",
            ],
            cwd: workspace,
        });
        await processStream.write(Buffer.from("reverse-process-over-devshell"));
        await processStream.finish();
        assert.equal(
            (await readServiceStream(processStream)).toString("utf8"),
            `${workspace}\nreverse-process-over-devshell`,
        );

        const transfer = await request(
            server.socketPath,
            "artifact.startTransfer",
            "@control",
            {
                instance: "reverse-test",
                sourcePath: `./${artifactSourceName}`,
                sourceWorkspace: workspace,
                targetInstance: "reverse-test",
                targetPath: `./${artifactTargetName}`,
                targetWorkspace: workspace,
            },
        );
        const transferId = transfer.transfer.transferId as string;
        await waitUntil(
            async () => {
                const status = await request(
                    server.socketPath,
                    "artifact.getTransfer",
                    "@control",
                    { transferId },
                );
                if (status.status === "failed") {
                    throw new Error(
                        `reverse artifact transfer failed: ${JSON.stringify(status.failure)}`,
                    );
                }
                return status.status === "completed";
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );
        assert.deepEqual(
            await readFile(join(workspace, artifactTargetName)),
            artifactSource,
        );

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
        const attached = await terminalClient.open(
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
        let terminalStream = attached;
        let terminalVersion = opened.version;
        let terminalClientSeq = 1;
        let cursorResponseCount = 0;
        const cursorResponder = createCursorPositionResponder(async (data) => {
            await terminalStream.send({
                name: "input",
                payload: {
                    clientSeq: terminalClientSeq++,
                    data,
                    generation: opened.generation,
                    terminalId: opened.terminalId,
                    version: terminalVersion,
                },
            });
        });
        const observeTerminalProtocol = async (
            event: ControlStreamMessage,
        ): Promise<void> => {
            if (process.platform !== "win32" || event.name !== "output") return;
            const payload = event.payload as { data?: string } | undefined;
            cursorResponseCount += await cursorResponder.consume(
                payload?.data ?? "",
            );
        };
        if (process.platform === "win32") {
            await waitForTerminal(
                attached,
                () => cursorResponseCount > 0,
                () =>
                    `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
                10_000,
                observeTerminalProtocol,
            );
        }
        const readyInputSeq = terminalClientSeq++;
        await attached.send({
            name: "input",
            payload: {
                clientSeq: readyInputSeq,
                data: terminalPrintCommand("reverse-pty-ready"),
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        });
        let inputAccepted = false;
        const ready = await waitForTerminal(
            attached,
            (event, output) => {
                if (
                    event.name === "inputAccepted" &&
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
        await attached.send({
            name: "resize",
            payload: {
                clientSeq: resizeClientSeq,
                cols: 100,
                generation: opened.generation,
                rows: 40,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        });
        const resized = await waitForTerminal(
            attached,
            (event) =>
                event.name === "resized" &&
                (event.payload as { clientSeq?: number } | undefined)
                    ?.clientSeq === resizeClientSeq,
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
        );
        terminalVersion = (resized.event.payload as { version: number })
            .version;
        if (process.platform === "win32") {
            cursorResponseCount += await cursorResponder.consume(
                resized.output,
            );
        }
        const sizedInputSeq = terminalClientSeq++;
        await attached.send({
            name: "input",
            payload: {
                clientSeq: sizedInputSeq,
                data: terminalSizeProbeCommand(),
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        });
        const sized = await waitForTerminal(
            attached,
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
        await attached.close();

        const resumed = await terminalClient.open(
            asInstanceName("reverse-test"),
            "terminal",
            "attach",
            {
                fromSeq: outputSeq,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        terminalStream = resumed;
        const resumedInputSeq = terminalClientSeq++;
        await terminalStream.send({
            name: "input",
            payload: {
                clientSeq: resumedInputSeq,
                data: terminalPrintCommand("reverse-pty-resumed"),
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
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
        const restartStartedMarker = "reverse-control-restart-started";
        await terminalStream.send({
            name: "input",
            payload: {
                clientSeq: restartInputSeq,
                data: terminalInputGatedPrintCommand(
                    restartStartedMarker,
                    "reverse-after-control-restart",
                ),
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        });
        let restartInputAccepted = false;
        const restartStarted = await waitForTerminal(
            terminalStream,
            (event, output) => {
                if (
                    event.name === "inputAccepted" &&
                    (event.payload as { clientSeq?: number } | undefined)
                        ?.clientSeq === restartInputSeq
                ) {
                    restartInputAccepted = true;
                }
                return (
                    restartInputAccepted &&
                    output.includes(restartStartedMarker)
                );
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        outputSeq = Math.max(outputSeq, restartStarted.lastOutputSeq);
        await resumed.close();
        terminalClient.close();

        await server.restart();
        await pointProxyAtControlMcp(proxy, server.socketPath);
        await waitUntil(
            async () => {
                const snapshot = await request(
                    server.socketPath,
                    "process.snapshot",
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
        const recovered = await restartedClient.open(
            asInstanceName("reverse-test"),
            "terminal",
            "attach",
            {
                fromSeq: outputSeq,
                generation: opened.generation,
                terminalId: opened.terminalId,
            },
        );
        terminalStream = recovered;
        const restartReleaseInputSeq = terminalClientSeq++;
        await terminalStream.send({
            name: "input",
            payload: {
                clientSeq: restartReleaseInputSeq,
                data: "release\r",
                generation: opened.generation,
                terminalId: opened.terminalId,
                version: terminalVersion,
            },
        });
        let restartReleaseAccepted = false;
        await waitForTerminal(
            terminalStream,
            (event, output) => {
                if (
                    event.name === "inputAccepted" &&
                    (event.payload as { clientSeq?: number } | undefined)
                        ?.clientSeq === restartReleaseInputSeq
                ) {
                    restartReleaseAccepted = true;
                }
                return (
                    restartReleaseAccepted &&
                    output.includes("reverse-after-control-restart")
                );
            },
            () =>
                `worker stdout:\n${workerStdout}\nworker stderr:\n${workerStderr}`,
            10_000,
            observeTerminalProtocol,
        );
        await recovered.close();

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
                    "process.snapshot",
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
        const controlHome = await createTestTempDirectory(
            "reverse-reenroll-control",
        );
        const controlRuntime = await createTestTempDirectory(
            "reverse-reenroll-runtime",
        );
        const workerHome = await createTestTempDirectory(
            "reverse-reenroll-worker-home",
        );
        const workerRuntime = await createTestTempDirectory(
            "reverse-reenroll-worker-runtime",
        );
        const workspace = await createTestTempDirectory(
            "reverse-reenroll-workspace",
        );
        const markerName = "reverse-reenroll-marker.txt";
        const marker = "reverse-reenroll-ok";
        await writeFile(join(workspace, markerName), marker, "utf8");
        const proxy = await startLoopbackHttpProxy();
        const publicBaseUrl = proxy.origin;
        const paths = new ControlPathHome(controlHome);
        const server = new Control({
            homeDirectory: controlHome,
            factory: new ControlFactory({
                builtinExtensionSources: [],
            }),
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
                },
                name: "reverse-reenroll",
                provider: "reverse",
            }),
            "utf8",
        );
        await server.start();
        await pointProxyAtControlMcp(proxy, server.socketPath);

        const enroll = async () => {
            const code = await new ReverseCredentialStore(
                controlHome,
            ).createDeviceCode("reverse-reenroll");
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
        await assertReverseMarker(
            server.socketPath,
            "reverse-reenroll",
            workspace,
            markerName,
            marker,
        );

        const retainedRoot = join(workerHome, ".devshell", "reverse-reenroll");
        const retainedLog = join(retainedRoot, "logs", "retained.log");
        const retainedArtifact = join(retainedRoot, "artifacts", "retained.bin");
        await writeFile(retainedLog, "saved log", "utf8");
        await writeFile(retainedArtifact, "saved artifact", "utf8");

        await enroll();
        assert.equal(await readFile(retainedLog, "utf8"), "saved log");
        assert.equal(await readFile(retainedArtifact, "utf8"), "saved artifact");
        const secondGeneration = await waitForReverseGeneration(
            server.socketPath,
            "reverse-reenroll",
            firstGeneration,
        );
        await assertReverseMarker(
            server.socketPath,
            "reverse-reenroll",
            workspace,
            markerName,
            marker,
        );

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
        await assertReverseMarker(
            server.socketPath,
            "reverse-reenroll",
            workspace,
            markerName,
            marker,
        );
    },
);

async function pointProxyAtControlMcp(
    proxy: LoopbackHttpProxy,
    socketPath: string,
): Promise<void> {
    const status = (await request(socketPath, "mcp.status", "@control")) as {
        listenAddress?: string;
    };
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
                "process.snapshot",
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
            input: {
                command: readRelativeMarkerCommand(markerName),
                timeoutMs: 30_000,
            },
            toolName: "bash_run",
            workspace,
        },
    );
    assert.equal(result.exitCode, 0, JSON.stringify(result));
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

async function request(
    socketPath: string,
    operation: string,
    destination: string,
    params?: JsonValue,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
    const [port, method] = operation.split(".");
    const client = createClient(socketPath);
    try {
        await negotiateClient(client, "cli");
        return await client.request(destination, port!, method!, params);
    } finally {
        client.close();
    }
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

async function negotiateClient(
    client: TestClient,
    clientKind: "cli" | "tui",
): Promise<void> {
    await client.request("@control", "server", "hello", {
        clientKind,
        protocolRange: CONTROL_PROTOCOL_RANGE,
    });
}

async function waitForTerminal(
    stream: MessageStream,
    predicate: (event: ControlStreamMessage, output: string) => boolean,
    diagnostic: () => string,
    timeoutMs = 10_000,
    observe?: (event: ControlStreamMessage) => Promise<void>,
): Promise<{
    event: ControlStreamMessage;
    lastOutputSeq: number;
    output: string;
}> {
    const deadline = Date.now() + timeoutMs;
    let output = "";
    let lastOutputSeq = 0;
    let lastEvent: ControlStreamMessage | undefined;
    while (Date.now() < deadline) {
        const remaining = Math.max(1, deadline - Date.now());
        let event: ControlStreamMessage;
        try {
            event = await Promise.race([
                readStreamData(stream),
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
        if (event.name === "output") {
            const payload = event.payload as
                { data?: string; seq?: number } | undefined;
            output += payload?.data ?? "";
            lastOutputSeq = Math.max(lastOutputSeq, payload?.seq ?? 0);
        }
        await observe?.(event);
        if (predicate(event, output)) return { event, lastOutputSeq, output };
    }
    throw new Error(
        `Terminal condition was not reached. Last event: ${lastEvent?.name ?? "none"}\n${diagnostic()}`,
    );
}

async function readStreamData(
    stream: MessageStream,
): Promise<ControlStreamMessage> {
    const next = await stream.readMessage();
    assert.equal(next.type, "data");
    return next.message as ControlStreamMessage;
}

function terminalOutputSeq(event: ControlStreamMessage): number {
    return event.name === "output"
        ? ((event.payload as { seq?: number } | undefined)?.seq ?? 0)
        : 0;
}

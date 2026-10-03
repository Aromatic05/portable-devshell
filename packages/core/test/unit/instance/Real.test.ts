import assert from "node:assert/strict";
import { execFile, spawn as nodeSpawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import {
    connect as connectNet,
    createServer as createNetServer,
    type Socket,
} from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";

import {
    Endpoint,
    Rpc,
    asInstanceName,
    controlErrorCodes,
    runtimeErrorCodes,
    StreamChannel,
    toolCallOutput,
    type JsonValue,
    type MessageStream,
} from "@portable-devshell/shared";
import {
    WorkerTransportDriverLocal,
    WorkerBinary,
    WorkerInstanceFactory,
    type WorkerInstance,
    WORKER_PROTOCOL_VERSION,
    type WorkerCommandResult,
    type WorkerTransport,
} from "@portable-devshell/core/testing";
import {
    realWorkerTestOptions,
    resolveTestWorkerBinary,
} from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { ToolCallPipeline } from "../../../src/tool/Pipeline.ts";
import { ToolCallHookSequence } from "../../../src/tool/hook/Sequence.ts";

const workerBinaryPath = resolveTestWorkerBinary();
const execFileAsync = promisify(execFile);
const rsyncAvailable =
    process.platform !== "win32" &&
    spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;

const cliToolCallContext = { source: "cli" } as const;

async function readServiceStream(stream: MessageStream): Promise<Buffer> {
    const chunks: Buffer[] = [];
    while (true) {
        const chunk = await stream.read();
        if (chunk === undefined) return Buffer.concat(chunks);
        chunks.push(Buffer.from(chunk));
    }
}

function rsyncWorkerTestOptions(): { skip: false | string } {
    const worker = realWorkerTestOptions(workerBinaryPath);
    if (worker.skip !== false) return worker;
    return {
        skip: rsyncAvailable ? false : "requires rsync on a non-Windows host",
    };
}

async function readSocketLine(
    socket: Socket,
): Promise<{ line: string; remainder: Buffer }> {
    return await new Promise((resolve, reject) => {
        let buffered = Buffer.alloc(0);
        const cleanup = () => {
            socket.off("data", onData);
            socket.off("end", onEnd);
            socket.off("error", onError);
        };
        const onData = (chunk: Buffer) => {
            buffered = Buffer.concat([buffered, chunk]);
            const newline = buffered.indexOf(0x0a);
            if (newline < 0) return;
            socket.pause();
            cleanup();
            resolve({
                line: buffered.subarray(0, newline).toString("utf8"),
                remainder: buffered.subarray(newline + 1),
            });
        };
        const onEnd = () => {
            cleanup();
            reject(new Error("rsync remote shell closed before its handshake"));
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };
        socket.on("data", onData);
        socket.once("end", onEnd);
        socket.once("error", onError);
    });
}

async function bridgeRsyncRemoteShell(
    instance: WorkerInstance,
    socket: Socket,
    cwd: string,
): Promise<void> {
    let stream: MessageStream | undefined;
    try {
        const handshake = await readSocketLine(socket);
        const parsed = JSON.parse(handshake.line) as {
            command?: unknown;
            host?: unknown;
        };
        if (
            parsed.host !== "dummy" ||
            !Array.isArray(parsed.command) ||
            parsed.command.length === 0 ||
            !parsed.command.every((value) => typeof value === "string")
        ) {
            throw new Error("invalid rsync remote shell handshake");
        }
        const [executable, ...args] = parsed.command as string[];
        stream = await instance.execProcess({
            executable: executable!,
            args,
            cwd,
        });
        if (handshake.remainder.byteLength > 0) {
            await stream.write(handshake.remainder);
        }
        socket.resume();

        const upload = (async () => {
            for await (const chunk of socket) {
                await stream!.write(Buffer.from(chunk));
            }
            await stream!.finish();
        })();
        const download = (async () => {
            while (true) {
                const chunk = await stream!.read();
                if (chunk === undefined) {
                    socket.end();
                    return;
                }
                if (!socket.write(Buffer.from(chunk))) {
                    await once(socket, "drain");
                }
            }
        })();
        await Promise.all([upload, download]);
    } catch (error) {
        if (stream !== undefined) {
            await stream
                .cancel({
                    message:
                        error instanceof Error ? error.message : String(error),
                })
                .catch(() => undefined);
        }
        socket.destroy(
            error instanceof Error ? error : new Error(String(error)),
        );
        throw error;
    }
}

test(
    "WorkerInstance completes lifecycle against frozen devshell-worker",
    realWorkerTestOptions(workerBinaryPath),
    async (t) => {
        const workspacePath = await createTestTempDirectory("instance");
        const homeDirectory = await createTestTempDirectory("instance-home");
        const runtimeDirectory =
            await createTestTempDirectory("instance-runtime");
        const instanceName = asInstanceName(`task-6-${process.pid}`);
        const factory = new WorkerInstanceFactory();
        const instance = factory.create({
            env: {
                ...process.env,
                HOME: homeDirectory,
                USERPROFILE: homeDirectory,
                XDG_RUNTIME_DIR: runtimeDirectory,
            },
            homeDirectory,
            name: instanceName,
            transport: new WorkerTransportDriverLocal({
                workerBinary: new WorkerBinary(workerBinaryPath!),
                spawnFunction: nodeSpawn,
            }),
        });

        t.after(async () => {
            await instance.stop();
            await instance.close();
            await rm(workspacePath, { force: true, recursive: true });
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(runtimeDirectory, { force: true, recursive: true });
        });

        const started = await instance.start();

        assert.equal(started.daemonState, "running");
        assert.equal(started.connectionState, "connected");
        assert.equal(started.ready, true);
        assert.equal(instance.handshake?.instance, instanceName);
        assert.equal(instance.handshake?.homeDirectory, homeDirectory);
        const bashRun = instance
            .listTools()
            .find((tool) => tool.name === "bash_run");
        assert.notEqual(bashRun, undefined);
        assert.notEqual(bashRun?.inputSchema, undefined);
        const fileGlob = instance
            .listTools()
            .find((tool) => tool.name === "file_glob");
        assert.notEqual(fileGlob, undefined);
        const fileGlobSchema = fileGlob?.inputSchema as {
            anyOf?: unknown;
            oneOf?: unknown;
            properties?: Record<string, unknown>;
            type?: unknown;
        };
        assert.equal(fileGlobSchema.type, "object");
        assert.equal(fileGlobSchema.anyOf, undefined);
        assert.equal(fileGlobSchema.oneOf, undefined);
        assert.notEqual(fileGlobSchema.properties?.patterns, undefined);
        assert.notEqual(fileGlobSchema.properties?.type, undefined);
        assert.notEqual(fileGlobSchema.properties?.cursor, undefined);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.transportConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
            ],
        );
        assert.deepEqual(replay.events[0]?.data, {
            connectionState: "disconnected",
            daemonState: "starting",
            previousDaemonState: "stopped",
            previousStatus: "stopped",
            ready: false,
            status: "running",
        });
        assert.deepEqual(replay.events.at(-1)?.data, {
            connectionState: "connected",
            daemonState: "running",
            previousReady: false,
            ready: true,
            status: "ready",
        });

        const stopped = await instance.stop();
        assert.equal(stopped.daemonState, "stopped");
        assert.equal(stopped.connectionState, "disconnected");
        assert.equal(stopped.ready, false);
    },
);

test(
    "WorkerInstance transfers artifact bytes over Frame services against frozen devshell-worker",
    realWorkerTestOptions(workerBinaryPath),
    async (t) => {
        const workspacePath = await createTestTempDirectory("artifact-frame");
        const homeDirectory = await createTestTempDirectory(
            "artifact-frame-home",
        );
        const runtimeDirectory = await createTestTempDirectory(
            "artifact-frame-runtime",
        );
        const instanceName = asInstanceName(`artifact-frame-${process.pid}`);
        const source = Buffer.alloc(700 * 1024);
        for (let index = 0; index < source.length; index += 1) {
            source[index] = index % 251;
        }
        await writeFile(`${workspacePath}/source.bin`, source);

        const instance = new WorkerInstanceFactory().create({
            env: {
                ...process.env,
                HOME: homeDirectory,
                USERPROFILE: homeDirectory,
                XDG_RUNTIME_DIR: runtimeDirectory,
            },
            homeDirectory,
            name: instanceName,
            transport: new WorkerTransportDriverLocal({
                workerBinary: new WorkerBinary(workerBinaryPath!),
                spawnFunction: nodeSpawn,
            }),
        });
        t.after(async () => {
            await instance.stop();
            await instance.close();
            await rm(workspacePath, { force: true, recursive: true });
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(runtimeDirectory, { force: true, recursive: true });
        });

        await instance.start();
        const opened = await instance.openArtifactPayload({
            expiresAtMs: Date.now() + 60_000,
            path: "./source.bin",
            workspace: workspacePath,
        });
        const chunk = await instance.readArtifactPayload({
            maxBytes: source.byteLength,
            offsetBytes: 0,
            payloadId: opened.payloadId,
        });
        assert.equal(chunk.returnedBytes, source.byteLength);
        assert.equal(chunk.totalBytes, source.byteLength);
        assert.equal(chunk.eof, true);
        assert.deepEqual(Buffer.from(chunk.bytes), source);

        const receive = await instance.beginArtifactReceive({
            descriptor: opened.descriptor,
            overwrite: false,
            targetPath: "./copy.bin",
            workspace: workspacePath,
        });
        const written = await instance.writeArtifactReceive({
            bytes: chunk.bytes,
            offsetBytes: receive.nextOffsetBytes,
            receiveId: receive.receiveId,
        });
        assert.equal(written.receivedBytes, source.byteLength);
        const finished = await instance.finishArtifactReceive(
            receive.receiveId,
        );
        assert.equal(finished.bytes, source.byteLength);
        assert.deepEqual(await readFile(`${workspacePath}/copy.bin`), source);
        await instance.closeArtifactPayload(opened.payloadId);
    },
);

test(
    "WorkerInstance exposes HTTP over tcp and process exec Frame services",
    realWorkerTestOptions(workerBinaryPath),
    async (t) => {
        const workspacePath = await createTestTempDirectory("service-consumer");
        const homeDirectory = await createTestTempDirectory(
            "service-consumer-home",
        );
        const runtimeDirectory = await createTestTempDirectory(
            "service-consumer-runtime",
        );
        const instanceName = asInstanceName(`service-consumer-${process.pid}`);
        const httpBody = "http-over-devshell";
        const server = createHttpServer((request, response) => {
            assert.equal(request.url, "/probe");
            response.writeHead(200, {
                Connection: "close",
                "Content-Length": Buffer.byteLength(httpBody),
                "Content-Type": "text/plain",
            });
            response.end(httpBody);
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const address = server.address();
        assert.ok(address !== null && typeof address !== "string");

        const instance = new WorkerInstanceFactory().create({
            env: {
                ...process.env,
                HOME: homeDirectory,
                USERPROFILE: homeDirectory,
                XDG_RUNTIME_DIR: runtimeDirectory,
            },
            homeDirectory,
            name: instanceName,
            transport: new WorkerTransportDriverLocal({
                workerBinary: new WorkerBinary(workerBinaryPath!),
                spawnFunction: nodeSpawn,
            }),
        });
        t.after(async () => {
            await instance.stop();
            await instance.close();
            server.close();
            await rm(workspacePath, { force: true, recursive: true });
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(runtimeDirectory, { force: true, recursive: true });
        });

        await instance.start();
        const tcp = await instance.connectTcp({
            host: "127.0.0.1",
            port: address.port,
        });
        await tcp.write(
            Buffer.from(
                "GET /probe HTTP/1.1\r\nHost: devshell\r\nConnection: close\r\n\r\n",
            ),
        );
        await tcp.finish();
        const httpResponse = (await readServiceStream(tcp)).toString("utf8");
        assert.match(httpResponse, /^HTTP\/1\.1 200 OK\r\n/u);
        assert.match(httpResponse, /\r\n\r\nhttp-over-devshell$/u);

        const socksServer = createNetServer(
            { allowHalfOpen: true },
            (client) => {
                let buffered = Buffer.alloc(0);
                let connecting = false;
                let stage: "greeting" | "request" | "tunnel" = "greeting";
                let upstream: Socket | undefined;

                const fail = (message: string) => {
                    client.destroy(new Error(message));
                };
                const flush = () => {
                    if (stage === "tunnel") {
                        if (buffered.byteLength > 0) {
                            upstream!.write(buffered);
                            buffered = Buffer.alloc(0);
                        }
                        return;
                    }
                    if (connecting) return;
                    if (stage === "greeting") {
                        if (buffered.byteLength < 2) return;
                        const methodCount = buffered[1]!;
                        if (buffered.byteLength < 2 + methodCount) return;
                        const methods = buffered.subarray(2, 2 + methodCount);
                        if (buffered[0] !== 0x05 || !methods.includes(0x00)) {
                            fail("unsupported SOCKS5 greeting");
                            return;
                        }
                        buffered = buffered.subarray(2 + methodCount);
                        client.write(Buffer.from([0x05, 0x00]));
                        stage = "request";
                    }
                    if (stage !== "request" || buffered.byteLength < 4) return;
                    if (
                        buffered[0] !== 0x05 ||
                        buffered[1] !== 0x01 ||
                        buffered[2] !== 0x00 ||
                        buffered[3] !== 0x01
                    ) {
                        fail("unsupported SOCKS5 CONNECT request");
                        return;
                    }
                    if (buffered.byteLength < 10) return;
                    const host = Array.from(buffered.subarray(4, 8)).join(".");
                    const port = buffered.readUInt16BE(8);
                    buffered = buffered.subarray(10);
                    connecting = true;
                    const remote = connectNet({ host, port }, () => {
                        upstream = remote;
                        connecting = false;
                        stage = "tunnel";
                        client.write(
                            Buffer.from([
                                0x05, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
                                0x00, 0x00,
                            ]),
                        );
                        flush();
                    });
                    remote.on("data", (chunk) => client.write(chunk));
                    remote.on("end", () => client.end());
                    remote.on("error", (error) => client.destroy(error));
                };

                client.on("data", (chunk) => {
                    if (stage === "tunnel") {
                        upstream!.write(chunk);
                        return;
                    }
                    buffered = Buffer.concat([buffered, chunk]);
                    flush();
                });
                client.on("end", () => upstream?.end());
                client.on("error", () => upstream?.destroy());
            },
        );
        socksServer.listen(0, "127.0.0.1");
        await once(socksServer, "listening");
        t.after(() => socksServer.close());
        const socksAddress = socksServer.address();
        assert.ok(socksAddress !== null && typeof socksAddress !== "string");

        const socks = await instance.connectTcp({
            host: "127.0.0.1",
            port: socksAddress.port,
        });
        let socksBuffered = Buffer.alloc(0);
        const readSocksBytes = async (byteLength: number): Promise<Buffer> => {
            while (socksBuffered.byteLength < byteLength) {
                const chunk = await socks.read();
                if (chunk === undefined)
                    throw new Error("SOCKS5 stream ended during handshake");
                socksBuffered = Buffer.concat([
                    socksBuffered,
                    Buffer.from(chunk),
                ]);
            }
            const value = socksBuffered.subarray(0, byteLength);
            socksBuffered = socksBuffered.subarray(byteLength);
            return value;
        };
        await socks.write(Buffer.from([0x05, 0x01, 0x00]));
        assert.deepEqual(await readSocksBytes(2), Buffer.from([0x05, 0x00]));
        await socks.write(
            Buffer.from([
                0x05,
                0x01,
                0x00,
                0x01,
                127,
                0,
                0,
                1,
                (address.port >> 8) & 0xff,
                address.port & 0xff,
            ]),
        );
        const socksReply = await readSocksBytes(10);
        assert.deepEqual(socksReply.subarray(0, 4), Buffer.from([5, 0, 0, 1]));
        await socks.write(
            Buffer.from(
                "GET /probe HTTP/1.1\r\nHost: devshell\r\nConnection: close\r\n\r\n",
            ),
        );
        await socks.finish();
        const proxiedChunks = [socksBuffered];
        while (true) {
            const chunk = await socks.read();
            if (chunk === undefined) break;
            proxiedChunks.push(Buffer.from(chunk));
        }
        const proxiedResponse = Buffer.concat(proxiedChunks).toString("utf8");
        assert.match(proxiedResponse, /^HTTP\/1\.1 200 OK\r\n/u);
        assert.match(proxiedResponse, /\r\n\r\nhttp-over-devshell$/u);

        const processStream = await instance.execProcess({
            executable: process.execPath,
            args: [
                "-e",
                "let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>process.stdout.write(process.cwd()+'\\n'+input));",
            ],
            cwd: workspacePath,
        });
        await processStream.write(Buffer.from("process-over-devshell"));
        await processStream.finish();
        assert.equal(
            (await readServiceStream(processStream)).toString("utf8"),
            `${workspacePath}\nprocess-over-devshell`,
        );
    },
);

test(
    "WorkerInstance carries a real rsync session over process exec Frame service",
    rsyncWorkerTestOptions(),
    async (t) => {
        const workspacePath = await createTestTempDirectory("rsync-worker");
        const sourcePath = await createTestTempDirectory("rsync-source");
        const homeDirectory =
            await createTestTempDirectory("rsync-worker-home");
        const runtimeDirectory = await createTestTempDirectory(
            "rsync-worker-runtime",
        );
        const targetPath = join(workspacePath, "target");
        const nestedSource = join(sourcePath, "nested");
        await mkdir(targetPath, { recursive: true });
        await mkdir(nestedSource, { recursive: true });
        const payload = Buffer.alloc(700 * 1024);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = index % 251;
        }
        await writeFile(join(sourcePath, "payload.bin"), payload);
        await writeFile(
            join(nestedSource, "note.txt"),
            "rsync-over-devshell\n",
        );

        const remoteShellPath = join(workspacePath, "rsync-remote-shell.mjs");
        await writeFile(
            remoteShellPath,
            `#!/usr/bin/env node
import { createConnection } from "node:net";
const [host, ...command] = process.argv.slice(2);
const port = Number(process.env.DEVSHELL_RSYNC_BRIDGE_PORT);
if (!Number.isInteger(port) || port <= 0) {
    throw new Error("DEVSHELL_RSYNC_BRIDGE_PORT is invalid");
}
const socket = createConnection({ allowHalfOpen: true, host: "127.0.0.1", port });
socket.once("connect", () => {
    socket.write(JSON.stringify({ host, command }) + "\\n");
    process.stdin.pipe(socket);
    socket.pipe(process.stdout, { end: false });
});
socket.on("end", () => {
    process.stdin.unpipe(socket);
    process.stdin.pause();
    socket.end();
});
socket.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
});
`,
            { mode: 0o700 },
        );

        const instance = new WorkerInstanceFactory().create({
            env: {
                ...process.env,
                HOME: homeDirectory,
                USERPROFILE: homeDirectory,
                XDG_RUNTIME_DIR: runtimeDirectory,
            },
            homeDirectory,
            name: asInstanceName(`rsync-worker-${process.pid}`),
            transport: new WorkerTransportDriverLocal({
                workerBinary: new WorkerBinary(workerBinaryPath!),
                spawnFunction: nodeSpawn,
            }),
        });
        const bridgeServer = createNetServer({ allowHalfOpen: true });
        const bridgeCompleted = new Promise<void>((resolve, reject) => {
            bridgeServer.once("connection", (socket) => {
                bridgeServer.close();
                void bridgeRsyncRemoteShell(
                    instance,
                    socket,
                    workspacePath,
                ).then(resolve, reject);
            });
            bridgeServer.once("error", reject);
        });
        bridgeServer.listen(0, "127.0.0.1");
        await once(bridgeServer, "listening");
        const bridgeAddress = bridgeServer.address();
        assert.ok(bridgeAddress !== null && typeof bridgeAddress !== "string");

        t.after(async () => {
            bridgeServer.close();
            await instance.stop();
            await instance.close();
            await rm(sourcePath, { force: true, recursive: true });
            await rm(workspacePath, { force: true, recursive: true });
            await rm(homeDirectory, { force: true, recursive: true });
            await rm(runtimeDirectory, { force: true, recursive: true });
        });

        await instance.start();
        await Promise.all([
            execFileAsync(
                "rsync",
                [
                    "-a",
                    "-e",
                    remoteShellPath,
                    `${sourcePath}/`,
                    `dummy:${targetPath}/`,
                ],
                {
                    env: {
                        ...process.env,
                        DEVSHELL_RSYNC_BRIDGE_PORT: String(bridgeAddress.port),
                    },
                    timeout: 30_000,
                },
            ),
            bridgeCompleted,
        ]);

        assert.deepEqual(
            await readFile(join(targetPath, "payload.bin")),
            payload,
        );
        assert.equal(
            await readFile(join(targetPath, "nested", "note.txt"), "utf8"),
            "rsync-over-devshell\n",
        );
    },
);

test("WorkerInstance serializes start and stop lifecycle operations", async () => {
    const homeDirectory = await createTestTempDirectory("instance-serialized");
    const harness = createWorkerInstanceHarness();
    const commands: string[] = [];
    let startCompleted = false;
    let stopOverlappedStart = false;
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => {
        releaseStart = resolve;
    });
    const transport: WorkerTransport = {
        ...harness.transport,
        async runWorkerCommand(command, options) {
            commands.push(command);
            if (command === "stop" && !startCompleted) {
                stopOverlappedStart = true;
            }
            if (command === "start") {
                await startGate;
                startCompleted = true;
            }
            return await harness.transport.runWorkerCommand(command, options);
        },
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("serialized-lifecycle"),
        transport,
    });

    try {
        const starting = instance.start();
        await waitFor(() => commands.includes("start"));
        const stopping = instance.stop();
        await new Promise<void>((resolve) => setImmediate(resolve));

        releaseStart();
        await starting;
        await stopping;
        assert.deepEqual(commands, ["start", "stop"]);
        assert.equal(stopOverlappedStart, false);
    } finally {
        releaseStart();
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance runs control-owned tool operations through ToolCall Hooks while the worker is stopped", async () => {
    const homeDirectory = await createTestTempDirectory("control-audit");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("control-audit"),
        transport: harness.transport,
    });

    const ingress = new ToolCallPipeline({
        hooks: () => ({ release() {}, sequence: new ToolCallHookSequence() }),
        resolveTarget: () => instance.toolCallTarget(),
    });

    try {
        const context = {
            ctxId: "ctx-control-audit",
            requestId: "request-control-audit",
            source: "mcp",
        } as const;
        const completed = await ingress.callOperation(
            asInstanceName("control-audit"),
            "todo_read",
            {},
            context,
            async () => ({ revision: 7 }),
        );
        assert.deepEqual(completed, { revision: 7 });

        await assert.rejects(
            ingress.callOperation(
                asInstanceName("control-audit"),
                "instance_status",
                { instance: "missing" },
                context,
                async () => {
                    const error = new Error("missing instance");
                    Object.assign(error, {
                        code: controlErrorCodes.instanceNotFound,
                        retryable: false,
                    });
                    throw error;
                },
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    controlErrorCodes.instanceNotFound,
                );
                return true;
            },
        );

        await assert.rejects(
            ingress.callOperation(
                asInstanceName("control-audit"),
                "artifact_transfer",
                { operation: "status", transferId: "transfer-1" },
                context,
                async () => {
                    const error = new Error("client cancelled");
                    Object.assign(error, {
                        code: runtimeErrorCodes.toolCallCancelled,
                        retryable: true,
                    });
                    throw error;
                },
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    runtimeErrorCodes.toolCallCancelled,
                );
                return true;
            },
        );

        const records = await instance.readToolCalls();
        assert.deepEqual(
            records.map((record) => ({
                ctxId: record.ctxId,
                error: record.error,
                input: record.input,
                output: record.output,
                requestId: record.requestId,
                source: record.source,
                status: record.status,
                toolName: record.toolName,
            })),
            [
                {
                    ctxId: "ctx-control-audit",
                    error: undefined,
                    input: {},
                    output: { revision: 7 },
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "completed",
                    toolName: "todo_read",
                },
                {
                    ctxId: "ctx-control-audit",
                    error: controlErrorCodes.instanceNotFound,
                    input: { instance: "missing" },
                    output: undefined,
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "failed",
                    toolName: "instance_status",
                },
                {
                    ctxId: "ctx-control-audit",
                    error: runtimeErrorCodes.toolCallCancelled,
                    input: { operation: "status", transferId: "transfer-1" },
                    output: undefined,
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "cancelled",
                    toolName: "artifact_transfer",
                },
            ],
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypesForCall = (callId: string | undefined) =>
            replay.events
                .filter((event) => jsonRecord(event.data)?.callId === callId)
                .map((event) => event.type);
        assert.deepEqual(eventTypesForCall(records[0]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "toolCall.completed",
        ]);
        assert.deepEqual(eventTypesForCall(records[1]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "toolCall.failed",
        ]);
        assert.deepEqual(eventTypesForCall(records[2]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "toolCall.cancelled",
        ]);
        const completedEvent = replay.events.find(
            (event) =>
                event.type === "toolCall.completed" &&
                jsonRecord(event.data)?.callId === records[0]?.callId,
        );
        assert.equal(jsonRecord(completedEvent?.data)?.output, undefined);
        assert.deepEqual(records[0]?.output, { revision: 7 });
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance trusted internal tool invocation does not record ingress audit", async () => {
    const homeDirectory = await createTestTempDirectory("internal-boundary");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("internal-boundary"),
        transport: harness.transport,
    });
    try {
        await instance.start();
        const internal = instance.invokeToolInternal(
            "bash_run",
            { command: "pwd" },
            cliToolCallContext,
        );
        await harness.waitForMethod("bash_run");
        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "/tmp/workspace\n",
        });

        assert.equal(jsonRecord(await internal)?.stdout, "/tmp/workspace\n");
        assert.deepEqual(await instance.readToolCalls(), []);
    } finally {
        await instance.stop();
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance rejects not-ready and records concurrent tool-call history", async () => {
    const homeDirectory = await createTestTempDirectory("instance-harness");
    const harness = createWorkerInstanceHarness();
    const instanceName = asInstanceName("task-6-harness");
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: instanceName,
        transport: harness.transport,
    });

    const ingress = new ToolCallPipeline({
        hooks: () => ({ release() {}, sequence: new ToolCallHookSequence() }),
        resolveTarget: () => instance.toolCallTarget(),
    });

    try {
        const stdout = "x".repeat(240);

        await assert.rejects(
            ingress.call(
                asInstanceName("task-6-harness"),
                "bash_run",
                { command: "pwd" },
                cliToolCallContext,
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    runtimeErrorCodes.instanceNotReady,
                );
                return true;
            },
        );

        const started = await instance.start();
        assert.equal(started.ready, true);

        const firstCall = ingress.call(
            asInstanceName("task-6-harness"),
            "bash_run",
            { command: "pwd" },
            cliToolCallContext,
        );
        const secondCall = ingress.call(
            asInstanceName("task-6-harness"),
            "bash_run",
            { command: "ls" },
            cliToolCallContext,
        );
        await harness.waitForMethodCount("bash_run", 2);
        const runningRecords = await instance.readToolCalls({
            status: "running",
        });
        assert.deepEqual(
            runningRecords.map((record) => ({
                status: record.status,
                toolName: record.toolName,
            })),
            [
                { status: "running", toolName: "bash_run" },
                { status: "running", toolName: "bash_run" },
            ],
        );

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout,
        });

        const result = await firstCall;
        assert.equal(jsonRecord(result)?.stdout, stdout);

        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "ls output\n",
        });

        const secondResult = await secondCall;
        assert.equal(jsonRecord(secondResult)?.stdout, "ls output\n");

        const invalidCall = ingress.call(
            asInstanceName("task-6-harness"),
            "bash_run",
            { bad: true } as JsonValue,
            cliToolCallContext,
        );
        await harness.waitForMethodCount("bash_run", 3);
        harness.fail("bash_run", "tool.invalidArguments");
        await assert.rejects(invalidCall, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                "tool.invalidArguments",
            );
            return true;
        });

        const records = await instance.readToolCalls();
        assert.deepEqual(
            records.map((record) => record.status),
            ["failed", "completed", "completed", "failed"],
        );
        assert.equal(records[0]?.error, runtimeErrorCodes.instanceNotReady);
        assert.equal(records[1]?.source, "cli");
        assert.equal(records[1]?.inputSummary, '{"command":"pwd"}');
        assert.deepEqual(records[1]?.output, { exitCode: 0 });
        assert.equal(records[1]?.stdoutBytes, 240);
        assert.equal(records[1]?.stderrBytes, 0);
        assert.equal(records[1]?.termination, undefined);
        assert.equal(records[3]?.error, "tool.invalidArguments");
        assert.deepEqual(
            (
                await instance.readToolCalls({
                    after: records[2]?.callId,
                    limit: 1,
                    status: "failed",
                    toolName: "bash_run",
                })
            ).map((record) => record.callId),
            [records[3]?.callId],
        );

        const logs = await instance.readLogs();
        assert.equal(logs.length, 2);
        assert.equal(logs[0]?.stream, "stdout");
        assert.equal(logs[0]?.message, stdout);
        assert.equal(logs[1]?.stream, "stdout");
        assert.equal(logs[1]?.message, "ls output\n");
        assert.deepEqual(toolCallOutput(records[1]!, logs), {
            exitCode: 0,
            stdout,
        });

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.slice(0, 8).map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.transportConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
            ],
        );

        const eventTypesForCall = (callId: string | undefined) =>
            replay.events
                .filter((event) => jsonRecord(event.data)?.callId === callId)
                .map((event) => event.type);

        assert.deepEqual(eventTypesForCall(records[0]?.callId), []);
        assert.deepEqual(eventTypesForCall(records[1]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "log.appended",
            "toolCall.completed",
        ]);
        assert.deepEqual(eventTypesForCall(records[2]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "log.appended",
            "toolCall.completed",
        ]);
        assert.deepEqual(eventTypesForCall(records[3]?.callId), [
            "toolCall.queued",
            "toolCall.running",
            "toolCall.failed",
        ]);

        const firstQueued = replay.events.find(
            (event) =>
                event.type === "toolCall.queued" &&
                jsonRecord(event.data)?.callId === records[1]?.callId,
        );
        const firstRunning = replay.events.find(
            (event) =>
                event.type === "toolCall.running" &&
                jsonRecord(event.data)?.callId === records[1]?.callId,
        );
        const failedEvent = replay.events.find(
            (event) =>
                event.type === "toolCall.failed" &&
                jsonRecord(event.data)?.callId === records[3]?.callId,
        );
        const completedEvent = replay.events.find(
            (event) =>
                event.type === "toolCall.completed" &&
                jsonRecord(event.data)?.callId === records[1]?.callId,
        );

        assert.deepEqual(firstQueued?.data, {
            callId: records[1]?.callId,
            inputSummary: '{"command":"pwd"}',
            queuedAt: jsonRecord(firstQueued?.data)?.queuedAt,
            source: "cli",
            startedAt: jsonRecord(firstQueued?.data)?.startedAt,
            status: "queued",
            toolName: "bash_run",
        });
        assert.deepEqual(firstRunning?.data, {
            callId: records[1]?.callId,
            inputSummary: '{"command":"pwd"}',
            source: "cli",
            startedAt: jsonRecord(firstQueued?.data)?.startedAt,
            status: "running",
            toolName: "bash_run",
        });
        assert.equal(jsonRecord(completedEvent?.data)?.output, undefined);
        assert.deepEqual(records[1]?.output, { exitCode: 0 });
        assert.deepEqual(failedEvent?.data, {
            callId: records[3]?.callId,
            completedAt: jsonRecord(failedEvent?.data)?.completedAt,
            errorCode: "tool.invalidArguments",
            inputSummary: '{"bad":true}',
            source: "cli",
            startedAt: jsonRecord(failedEvent?.data)?.startedAt,
            status: "failed",
            toolName: "bash_run",
        });

        await instance.stop();
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance restores a stopped disconnected snapshot when start fails", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-start-failure",
    );
    const transport: WorkerTransport = {
        async connectWorkerChannel() {
            throw new Error(
                "channel must not be connected after a failed start",
            );
        },
        async runWorkerCommand(command): Promise<WorkerCommandResult> {
            assert.equal(command, "start");
            return {
                exitCode: 1,
                stderr: "start failed",
                stdout: "",
            };
        },
        async installWorker(): Promise<void> {},
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-start-failure"),
        transport,
    });

    try {
        await assert.rejects(instance.start(), (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.workerStartFailed,
            );
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "stopped");
        assert.equal(snapshot.connectionState, "disconnected");
        assert.equal(snapshot.ready, false);
        assert.equal(
            snapshot.lastErrorCode,
            runtimeErrorCodes.workerStartFailed,
        );
        assert.equal(
            snapshot.lastErrorMessage,
            "Worker start failed for instance task-6-start-failure.",
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            ["instance.statusChanged", "instance.statusChanged"],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshes actual daemon state when stop fails", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-stop-failure",
    );
    const harness = createWorkerInstanceHarness();
    const transport: WorkerTransport = {
        ...harness.transport,
        async runWorkerCommand(command, options) {
            if (command === "stop") {
                return {
                    exitCode: 1,
                    stderr: "stop failed",
                    stdout: "",
                };
            }
            return await harness.transport.runWorkerCommand(command, options);
        },
    };
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-stop-failure"),
        transport,
    });

    try {
        await instance.start();
        harness.setStatus("running");

        await assert.rejects(instance.stop(), (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                runtimeErrorCodes.workerStopFailed,
            );
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "running");
        assert.equal(snapshot.connectionState, "connected");
        assert.equal(snapshot.ready, true);
        assert.equal(
            snapshot.lastErrorCode,
            runtimeErrorCodes.workerStopFailed,
        );
        assert.equal(
            snapshot.lastErrorMessage,
            "Worker stop failed for instance task-6-stop-failure.",
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshStatus updates snapshot from worker status without auto start", async () => {
    const homeDirectory = await createTestTempDirectory("instance-refresh");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-refresh"),
        transport: harness.transport,
    });

    try {
        const stopped = await instance.refreshStatus();
        assert.equal(stopped.daemonState, "stopped");
        assert.equal(stopped.connectionState, "disconnected");
        assert.equal(harness.requestedMethods(), 0);

        harness.setStatus("running");
        const running = await instance.refreshStatus();
        assert.equal(running.daemonState, "running");
        assert.equal(running.connectionState, "connected");
        assert.equal(running.ready, true);
        assert.equal(instance.listTools()[0]?.name, "bash_run");

        harness.setStatus("stale");
        const stale = await instance.refreshStatus();
        assert.equal(stale.daemonState, "stale");
        assert.equal(stale.connectionState, "disconnected");
        assert.equal(stale.ready, false);

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.transportConnected",
                "worker.schemaRefreshed",
                "instance.connectionChanged",
                "instance.readyChanged",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
            ],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance refreshStatus on a connected instance keeps ready without a transient not-ready", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-refresh-connected",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-refresh-connected"),
        transport: harness.transport,
    });

    try {
        harness.setStatus("running");
        const connected = await instance.refreshStatus();
        assert.equal(connected.ready, true);
        assert.equal(connected.connectionState, "connected");

        const before = instance.subscribe(1);
        assert.equal(before.kind, "events");
        const beforeSeq = before.lastSeq;

        const refreshed = await instance.refreshStatus();
        assert.equal(refreshed.ready, true);
        assert.equal(refreshed.connectionState, "connected");

        const after = instance.subscribe(beforeSeq + 1);
        assert.equal(after.kind, "events");
        const transientReadyChanged = after.events.find(
            (event) =>
                event.type === "instance.readyChanged" &&
                (event.data as { ready?: boolean } | undefined)?.ready ===
                    false,
        );
        assert.equal(
            transientReadyChanged,
            undefined,
            "refreshStatus must not transiently flip ready to false",
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance reconnectRpc refreshes schema after an rpc disconnect", async () => {
    const homeDirectory = await createTestTempDirectory("instance-reconnect");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-reconnect"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        assert.deepEqual(
            instance.listTools()[0]?.inputSchema,
            toolSchemaFor("command"),
        );

        harness.setTools([
            {
                requiredCapabilities: ["execute"],
                description: "Run a shell command.",
                group: "bash",
                inputSchema: toolSchemaFor("cwd"),
                name: "bash_run",
                outputSchema: { type: "object" },
            },
        ]);
        harness.disconnect();
        await harness.waitForMethodCount("tools.list", 2);
        await waitFor(
            () => instance.snapshot().connectionState === "connected",
        );

        assert.equal(instance.snapshot().connectionState, "connected");
        assert.deepEqual(
            instance.listTools()[0]?.inputSchema,
            toolSchemaFor("cwd"),
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.deepEqual(
            replay.events.map((event) => event.type),
            [
                "instance.statusChanged",
                "instance.connectionChanged",
                "worker.transportConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.transportDisconnected",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.transportConnected",
                "worker.schemaRefreshed",
                "instance.connectionChanged",
                "instance.readyChanged",
            ],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance keeps retrying automatic rpc reconnect after a transient failure", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-reconnect-retry",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("task-6-reconnect-retry"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        harness.failNextRpcConnections();
        harness.disconnect();

        await harness.waitForMethodCount("tools.list", 2);
        await waitFor(
            () => instance.snapshot().connectionState === "connected",
        );
        assert.equal(instance.snapshot().connectionState, "connected");
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

type HarnessTool = {
    requiredCapabilities: ["execute"];
    description: string;
    group: string;
    inputSchema: JsonValue;
    name: string;
    outputSchema: JsonValue;
};

function createWorkerInstanceHarness(): {
    disconnect: () => void;
    fail: (method: string, code: string) => void;
    failNextRpcConnections: (count?: number) => void;
    setTools: (tools: HarnessTool[]) => void;
    transport: WorkerTransport;
    requestedMethods: () => number;
    respond: (method: string, result: Record<string, JsonValue>) => void;
    setStatus: (status: "running" | "stale" | "stopped") => void;
    waitForMethod: (method: string) => Promise<void>;
    waitForMethodCount: (method: string, count: number) => Promise<void>;
} {
    type PendingCall = {
        reject(error: Error): void;
        resolve(value: JsonValue): void;
    };
    const pending = new Map<string, PendingCall[]>();
    const requestMethods: string[] = [];
    const methodWaiters = new Map<string, Array<() => void>>();
    let commandStatus: "running" | "stale" | "stopped" = "stopped";
    let rpcConnectFailures = 0;
    let tools: HarnessTool[] = [
        {
            requiredCapabilities: ["execute"] as ["execute"],
            description: "Run a shell command.",
            group: "bash",
            inputSchema: toolSchemaFor("command"),
            name: "bash_run",
            outputSchema: { type: "object" },
        },
    ];
    let activeConnection:
        | {
              channel: StreamChannel;
              endpoint: Endpoint;
              protocols: Rpc[];
          }
        | undefined;

    const observe = (method: string) => {
        requestMethods.push(method);
        methodWaiters
            .get(method)
            ?.splice(0)
            .forEach((resolve) => resolve());
    };
    const pendingHandler = (method: string) => {
        return async (): Promise<JsonValue> => {
            observe(method);
            return await new Promise<JsonValue>((resolve, reject) => {
                const calls = pending.get(method) ?? [];
                calls.push({ reject, resolve });
                pending.set(method, calls);
            });
        };
    };
    const closeActive = (error?: Error) => {
        const active = activeConnection;
        if (active === undefined) return;
        activeConnection = undefined;
        active.channel.close(error);
        for (const protocol of active.protocols) protocol.close();
        active.endpoint.close();
    };

    const transport: WorkerTransport = {
        async connectWorkerChannel(options) {
            if (rpcConnectFailures > 0) {
                rpcConnectFailures -= 1;
                throw new Error("transient rpc connection failure");
            }
            const clientToServer = new PassThrough();
            const serverToClient = new PassThrough();
            const pair: {
                client?: StreamChannel;
                server?: StreamChannel;
                closed: boolean;
            } = { closed: false };
            const closePair = (error?: Error) => {
                if (pair.closed) return;
                pair.closed = true;
                pair.client?.close(error);
                pair.server?.close(error);
            };
            const client = new StreamChannel(serverToClient, clientToServer, {
                closeTransport: closePair,
            });
            const server = new StreamChannel(clientToServer, serverToClient, {
                closeTransport: closePair,
            });
            pair.client = client;
            pair.server = server;

            const endpoint = new Endpoint({
                host: `${options.instanceName}-worker`,
            });
            const core = new Rpc(endpoint.bind("core"), {
                "worker.ping": () => {
                    observe("worker.ping");
                    return { pong: true };
                },
                "worker.handshake": () => {
                    observe("worker.handshake");
                    return {
                        platform: { arch: "x64", os: "linux" },
                        protocolVersion: WORKER_PROTOCOL_VERSION,
                        workerSha256: null,
                        workerVersion: "0.1.0",
                    };
                },
            });
            const tool = new Rpc(endpoint.bind("tool"), {
                "tools.list": () => {
                    observe("tools.list");
                    return { tools };
                },
                bash_run: pendingHandler("bash_run"),
            });
            const protocols = [core, tool];
            activeConnection = { channel: server, endpoint, protocols };
            server.onClose(() => {
                if (activeConnection?.channel !== server) return;
                activeConnection = undefined;
                for (const protocol of protocols) protocol.close();
                endpoint.close();
            });
            void endpoint.accept(server).catch(() => undefined);
            return client;
        },
        async runWorkerCommand(command): Promise<WorkerCommandResult> {
            if (command === "status") {
                return {
                    exitCode: 0,
                    stderr: "",
                    stdout: JSON.stringify({
                        instance: "task-6-harness",
                        ok: true,
                        pid: commandStatus === "stopped" ? null : 4321,
                        running: commandStatus === "running",
                        state: commandStatus,
                        workspace:
                            commandStatus === "running"
                                ? "/tmp/workspace"
                                : null,
                    }),
                };
            }
            return {
                exitCode: 0,
                stderr: "",
                stdout:
                    command === "start"
                        ? JSON.stringify({
                              running: true,
                              workspace: "/tmp/workspace",
                          })
                        : JSON.stringify({ running: false }),
            };
        },
        async installWorker(): Promise<void> {},
    };

    const takePending = (method: string): PendingCall => {
        const calls = pending.get(method);
        const call = calls?.shift();
        if (call === undefined)
            throw new Error(`No pending request for ${method}.`);
        if (calls?.length === 0) pending.delete(method);
        return call;
    };

    return {
        disconnect() {
            closeActive(new Error("injected rpc transport disconnect"));
        },
        fail(method, code) {
            takePending(method).reject(
                Object.assign(new Error(`worker rejected ${method}`), {
                    code,
                    retryable: false,
                }),
            );
        },
        failNextRpcConnections(count = 1) {
            rpcConnectFailures = count;
        },
        setTools(nextTools) {
            tools = nextTools;
        },
        transport,
        requestedMethods() {
            return requestMethods.length;
        },
        respond(method, result) {
            takePending(method).resolve(result);
        },
        setStatus(status) {
            commandStatus = status;
        },
        waitForMethod(method) {
            if (requestMethods.includes(method)) return Promise.resolve();
            return new Promise<void>((resolve) => {
                const waiters = methodWaiters.get(method) ?? [];
                waiters.push(resolve);
                methodWaiters.set(method, waiters);
            });
        },
        waitForMethodCount(method, count) {
            if (
                requestMethods.filter((value) => value === method).length >=
                count
            )
                return Promise.resolve();
            return new Promise<void>((resolve) => {
                const observeCount = () => {
                    if (
                        requestMethods.filter((value) => value === method)
                            .length >= count
                    ) {
                        resolve();
                        return;
                    }
                    const waiters = methodWaiters.get(method) ?? [];
                    waiters.push(observeCount);
                    methodWaiters.set(method, waiters);
                };
                observeCount();
            });
        },
    };
}

function jsonRecord(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function toolSchemaFor(field: string): JsonValue {
    return {
        properties: {
            [field]: { type: "string" },
        },
        required: [field],
        type: "object",
    };
}

async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for condition.");
}

import assert from "node:assert/strict";
import {
    execFile,
    spawn as nodeSpawn,
    spawnSync,
} from "node:child_process";
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
    asInstanceName,
    errorCodes,
    StreamChannel,
    toolCallOutput,
    type JsonValue,
} from "@portable-devshell/shared";
import {
    encodePacket,
    FrameProtocol,
    frameResetCodes,
    PacketBuffer,
    type FrameStream,
} from "@portable-devshell/shared/transport/frame";
import {
    WorkerTransportDriverLocal,
    WorkerBinary,
    WorkerInstanceFactory,
    type WorkerInstance,
    WORKER_PROTOCOL_VERSION,
    decodeWorkerRpcMessage,
    encodeWorkerRpcMessage,
    type WorkerCommandResult,
    type WorkerTransport,
    type WorkerRpcResponseEnvelope,
} from "@portable-devshell/core/testing";
import {
    realWorkerTestOptions,
    resolveTestWorkerBinary,
} from "../../../../../test/TestPlatformSupport.ts";
import { createTestTempDirectory } from "../../../../../test/TestTempDirectory.ts";
import { ToolCallBoundarySequence } from "../../../src/toolcall/boundary/Sequence.ts";

const workerBinaryPath = resolveTestWorkerBinary();
const execFileAsync = promisify(execFile);
const rsyncAvailable =
    process.platform !== "win32" &&
    spawnSync("rsync", ["--version"], { stdio: "ignore" }).status === 0;

const cliToolCallContext = { source: "cli" } as const;

async function readServiceStream(stream: FrameStream): Promise<Buffer> {
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
    let stream: FrameStream | undefined;
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
        stream = await instance.execProcess({ executable: executable!, args, cwd });
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
        if (stream !== undefined && !stream.closed) {
            await stream
                .reset(
                    frameResetCodes.cancelled,
                    error instanceof Error ? error.message : String(error),
                )
                .catch(() => undefined);
        }
        socket.destroy(error instanceof Error ? error : new Error(String(error)));
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
                "worker.rpcConnected",
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
        const homeDirectory = await createTestTempDirectory("artifact-frame-home");
        const runtimeDirectory =
            await createTestTempDirectory("artifact-frame-runtime");
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
        assert.deepEqual(Buffer.from(chunk.content, "base64"), source);

        const receive = await instance.beginArtifactReceive({
            descriptor: opened.descriptor,
            overwrite: false,
            targetPath: "./copy.bin",
            workspace: workspacePath,
        });
        const written = await instance.writeArtifactReceive({
            content: chunk.content,
            offsetBytes: receive.nextOffsetBytes,
            receiveId: receive.receiveId,
        });
        assert.equal(written.receivedBytes, source.byteLength);
        const finished = await instance.finishArtifactReceive(receive.receiveId);
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
        const homeDirectory = await createTestTempDirectory("service-consumer-home");
        const runtimeDirectory =
            await createTestTempDirectory("service-consumer-runtime");
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
                        if (
                            buffered[0] !== 0x05 ||
                            !methods.includes(0x00)
                        ) {
                            fail("unsupported SOCKS5 greeting");
                            return;
                        }
                        buffered = buffered.subarray(2 + methodCount);
                        client.write(Buffer.from([0x05, 0x00]));
                        stage = "request";
                    }
                    if (stage !== "request" || buffered.byteLength < 4)
                        return;
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
                                0x05,
                                0x00,
                                0x00,
                                0x01,
                                0x00,
                                0x00,
                                0x00,
                                0x00,
                                0x00,
                                0x00,
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
        const homeDirectory = await createTestTempDirectory("rsync-worker-home");
        const runtimeDirectory =
            await createTestTempDirectory("rsync-worker-runtime");
        const targetPath = join(workspacePath, "target");
        const nestedSource = join(sourcePath, "nested");
        await mkdir(targetPath, { recursive: true });
        await mkdir(nestedSource, { recursive: true });
        const payload = Buffer.alloc(700 * 1024);
        for (let index = 0; index < payload.length; index += 1) {
            payload[index] = index % 251;
        }
        await writeFile(join(sourcePath, "payload.bin"), payload);
        await writeFile(join(nestedSource, "note.txt"), "rsync-over-devshell\n");

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
                void bridgeRsyncRemoteShell(instance, socket, workspacePath).then(
                    resolve,
                    reject,
                );
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

        assert.deepEqual(await readFile(join(targetPath, "payload.bin")), payload);
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

test("WorkerInstance runs control-owned tool operations through ToolCall Boundary while the worker is stopped", async () => {
    const homeDirectory = await createTestTempDirectory("control-audit");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("control-audit"),
        transport: harness.transport,
    });

    try {
        const context = {
            ctxId: "ctx-control-audit",
            requestId: "request-control-audit",
            source: "mcp",
        } as const;
        const completed = await instance.callToolOperation(
            "todo_read",
            {},
            context,
            async () => ({ revision: 7 }),
        );
        assert.deepEqual(completed, { revision: 7 });

        await assert.rejects(
            instance.callToolOperation(
                "instance_status",
                { instance: "missing" },
                context,
                async () => {
                    const error = new Error("missing instance");
                    Object.assign(error, {
                        code: errorCodes.instanceMissing,
                        retryable: false,
                    });
                    throw error;
                },
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    errorCodes.instanceMissing,
                );
                return true;
            },
        );

        await assert.rejects(
            instance.callToolOperation(
                "artifact_transfer",
                { operation: "status", transferId: "transfer-1" },
                context,
                async () => {
                    const error = new Error("client cancelled");
                    Object.assign(error, {
                        code: errorCodes.coreToolCallCancelled,
                        retryable: true,
                    });
                    throw error;
                },
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    errorCodes.coreToolCallCancelled,
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
                    error: errorCodes.instanceMissing,
                    input: { instance: "missing" },
                    output: undefined,
                    requestId: "request-control-audit",
                    source: "mcp",
                    status: "failed",
                    toolName: "instance_status",
                },
                {
                    ctxId: "ctx-control-audit",
                    error: errorCodes.coreToolCallCancelled,
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

test("WorkerInstance trusted internal tool invocation does not re-enter ToolCall Boundary", async () => {
    const homeDirectory = await createTestTempDirectory("internal-boundary");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        homeDirectory,
        name: asInstanceName("internal-boundary"),
        transport: harness.transport,
    });
    let boundaryAcquires = 0;
    let reviews = 0;
    let rewrites = 0;

    instance.bindToolCallBoundary(async () => {
        boundaryAcquires += 1;
        return {
            release() {},
            sequence: new ToolCallBoundarySequence({
                reviews: [async () => {
                    reviews += 1;
                    return { decision: "accept" };
                }],
                rewrites: [async (input) => {
                    rewrites += 1;
                    return input.text;
                }],
            }),
        };
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

        assert.equal(
            jsonRecord(await internal)?.stdout,
            "/tmp/workspace\n",
        );
        assert.equal(boundaryAcquires, 0);
        assert.equal(reviews, 0);
        assert.equal(rewrites, 0);
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

    try {
        const stdout = "x".repeat(240);

        await assert.rejects(
            instance.callTool(
                "bash_run",
                { command: "pwd" },
                cliToolCallContext,
            ),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    errorCodes.coreInstanceNotReady,
                );
                return true;
            },
        );

        const started = await instance.start();
        assert.equal(started.ready, true);

        const firstCall = instance.callTool(
            "bash_run",
            { command: "pwd" },
            cliToolCallContext,
        );
        const secondCall = instance.callTool(
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

        const invalidCall = instance.callTool(
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
        assert.equal(records[0]?.error, errorCodes.coreInstanceNotReady);
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
                "worker.rpcConnected",
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

test("WorkerInstance waits for approval before invoking tools and records approval decisions", async () => {
    const homeDirectory = await createTestTempDirectory("instance-approval");
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { source: "cli", workspace: homeDirectory },
        );

        const pendingApproval = await waitForPendingApproval(instance);
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        const approvals = await instance.listApprovals();
        assert.equal(approvals.length, 1);
        assert.equal(approvals[0]?.status, "pending");
        assert.equal(approvals[0]?.source, "cli");
        assert.equal(approvals[0]?.workspace, homeDirectory);

        const approvalId = pendingApproval.approvalId;
        assert.notEqual(approvalId, "");
        assert.equal(
            (await instance.getApproval(approvalId)).status,
            "pending",
        );
        assert.deepEqual(
            (await instance.readToolCalls({ status: "pendingApproval" })).map(
                (record) => ({
                    approvalId: record.approvalId,
                    status: record.status,
                    toolName: record.toolName,
                }),
            ),
            [
                {
                    approvalId,
                    status: "pendingApproval",
                    toolName: "bash_run",
                },
            ],
        );

        const pendingReplay = instance.subscribe(1);
        assert.equal(pendingReplay.kind, "events");
        assert.equal(
            pendingReplay.events.some(
                (event) => event.type === "approval.requested",
            ),
            true,
        );
        assert.equal(
            pendingReplay.events.some(
                (event) => event.type === "toolCall.pendingApproval",
            ),
            true,
        );
        assert.equal(
            pendingReplay.events.some(
                (event) => event.type === "toolCall.running",
            ),
            false,
        );

        await instance.decideApproval(approvalId, {
            decidedBy: "cli",
            decision: "approve",
            reason: "approved in test",
        });
        await harness.waitForMethod("bash_run");
        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "/tmp/workspace\n",
        });

        const result = await callPromise;
        assert.equal(jsonRecord(result)?.stdout, "/tmp/workspace\n");

        const records = await instance.readToolCalls();
        assert.equal(records[0]?.status, "completed");
        assert.equal(records[0]?.decision, "approved");
        assert.equal(records[0]?.approvalId, approvalId);

        const approved = await instance.getApproval(approvalId);
        assert.equal(approved.status, "approved");
        assert.equal(approved.decision?.decision, "approve");
        assert.equal(approved.decision?.decidedBy, "cli");

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.requested"), true);
        assert.equal(eventTypes.includes("approval.approved"), true);
        assert.equal(eventTypes.includes("toolCall.pendingApproval"), true);
        assert.equal(eventTypes.includes("toolCall.running"), true);
        assert.equal(eventTypes.includes("toolCall.completed"), true);
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("caller-recorded Worker calls keep approval enforcement without host tool audit", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-delegated-approval",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-delegated-approval"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            {
                ctxId: "agent-session",
                extensionId: "agent",
                source: "extension",
                workspace: homeDirectory,
            },
            undefined,
            undefined,
            undefined,
            undefined,
            "caller",
        );

        const pendingApproval = await waitForPendingApproval(instance);
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        assert.equal(
            (await instance.getApproval(pendingApproval.approvalId)).recording,
            "caller",
        );
        assert.equal(
            (await instance.getApproval(pendingApproval.approvalId)).status,
            "pending",
        );
        assert.deepEqual(await instance.readToolCalls(), []);

        const pendingReplay = instance.subscribe(1);
        assert.equal(pendingReplay.kind, "events");
        assert.equal(
            pendingReplay.events.some(
                (event) => event.type === "approval.requested",
            ),
            true,
        );
        assert.equal(
            pendingReplay.events.some((event) =>
                event.type.startsWith("toolCall."),
            ),
            false,
        );

        await instance.decideApproval(pendingApproval.approvalId, {
            decidedBy: "cli",
            decision: "approve",
            reason: "approved delegated Agent call",
        });
        await harness.waitForMethod("bash_run");
        harness.respond("bash_run", {
            exitCode: 0,
            stderr: "",
            stdout: "/tmp/workspace\n",
        });
        const result = await callPromise;
        assert.equal(jsonRecord(result)?.stdout, "/tmp/workspace\n");

        assert.deepEqual(await instance.readToolCalls(), []);
        assert.deepEqual(await instance.readLogs(), []);
        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        assert.equal(
            replay.events.some((event) => event.type === "approval.approved"),
            true,
        );
        assert.equal(
            replay.events.some((event) => event.type.startsWith("toolCall.")),
            false,
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance cancels a pending approval when the caller aborts", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-approval-cancel",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval-cancel"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const controller = new AbortController();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            {
                requestId: "req-cancel-approval",
                ctxId: "ctx-cancel",
                source: "mcp",
            },
            controller.signal,
        );

        const approvalId = (await waitForPendingApproval(instance)).approvalId;
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        controller.abort("client timeout");
        await assert.rejects(
            instance.decideApproval(approvalId, {
                decidedBy: "cli",
                decision: "approve",
            }),
            (error: unknown) => {
                assert.equal(
                    (error as { code?: string }).code,
                    errorCodes.coreApprovalAlreadyDecided,
                );
                return true;
            },
        );

        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallCancelled,
            );
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        assert.equal(
            (await instance.getApproval(approvalId)).status,
            "cancelled",
        );
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"],
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.cancelled"), true);
        assert.equal(eventTypes.includes("toolCall.cancelled"), true);
        assert.equal(eventTypes.includes("toolCall.running"), false);
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance stop cancels pending approvals before stopping the worker", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-stop-pending-approval",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-stop-pending-approval"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            {
                requestId: "req-stop-pending",
                ctxId: "ctx-stop-pending",
                source: "mcp",
            },
        );
        const approvalId = (await waitForPendingApproval(instance)).approvalId;

        const stopped = await instance.stop();
        assert.equal(stopped.daemonState, "stopped");
        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallCancelled,
            );
            return true;
        });
        assert.equal(
            (await instance.getApproval(approvalId)).status,
            "cancelled",
        );
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance cancellation API terminates a pending approval before tool execution", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-approval-admin-cancel",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        homeDirectory,
        name: asInstanceName("task-6-approval-admin-cancel"),
        transport: harness.transport,
    });

    try {
        await instance.start();
        const beforeInvokeCount = harness.requestedMethods();
        const callPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            {
                requestId: "req-admin-cancel",
                ctxId: "ctx-disabled",
                source: "mcp",
            },
        );
        const approvalId = (await waitForPendingApproval(instance)).approvalId;

        const cancelled = await instance.cancelApproval(
            approvalId,
            "Context ctx-disabled was disabled.",
        );
        assert.equal(cancelled.status, "cancelled");
        await assert.rejects(callPromise, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreToolCallCancelled,
            );
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeInvokeCount);
        assert.equal(
            (await instance.getApproval(approvalId)).status,
            "cancelled",
        );
        assert.deepEqual(
            (await instance.readToolCalls()).map((record) => record.status),
            ["cancelled"],
        );
    } finally {
        await instance.close();
        await rm(homeDirectory, { force: true, recursive: true });
    }
});

test("WorkerInstance denies and expires approval-gated calls without invoking tools", async () => {
    const homeDirectory = await createTestTempDirectory(
        "instance-approval-fail",
    );
    const harness = createWorkerInstanceHarness();
    const instance = new WorkerInstanceFactory().create({
        approvalPolicy: { mode: "ask" },
        approvalTimeout: { ms: 40 },
        homeDirectory,
        name: asInstanceName("task-6-approval-fail"),
        transport: harness.transport,
    });

    try {
        await instance.start();

        const beforeDeniedInvokeCount = harness.requestedMethods();
        const deniedPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            { requestId: "req-deny", source: "mcp" },
        );
        const deniedApprovalId = (await waitForPendingApproval(instance))
            .approvalId;
        assert.equal(harness.requestedMethods(), beforeDeniedInvokeCount);
        await instance.decideApproval(deniedApprovalId, {
            decidedBy: "cli",
            decision: "deny",
            reason: "denied in test",
        });
        await assert.rejects(deniedPromise, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreApprovalDenied,
            );
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeDeniedInvokeCount);

        const afterDenied = await instance.readToolCalls();
        assert.equal(afterDenied[0]?.status, "denied");
        assert.equal(afterDenied[0]?.source, "mcp");
        assert.equal(afterDenied[0]?.decision, "denied");

        const beforeExpiredInvokeCount = harness.requestedMethods();
        const expiredPromise = instance.callTool(
            "bash_run",
            { command: "pwd" },
            cliToolCallContext,
        );
        await assert.rejects(expiredPromise, (error: unknown) => {
            assert.equal(
                (error as { code?: string }).code,
                errorCodes.coreApprovalExpired,
            );
            return true;
        });
        assert.equal(harness.requestedMethods(), beforeExpiredInvokeCount);

        const records = await instance.readToolCalls();
        assert.deepEqual(
            records.map((record) => record.status),
            ["denied", "expired"],
        );
        assert.deepEqual(
            records.map((record) => record.decision),
            ["denied", "expired"],
        );

        const replay = instance.subscribe(1);
        assert.equal(replay.kind, "events");
        const eventTypes = replay.events.map((event) => event.type);
        assert.equal(eventTypes.includes("approval.denied"), true);
        assert.equal(eventTypes.includes("approval.expired"), true);
        assert.equal(eventTypes.includes("toolCall.denied"), true);
        assert.equal(eventTypes.includes("toolCall.expired"), true);
        assert.equal(eventTypes.includes("toolCall.running"), false);
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
            throw new Error("channel must not be connected after a failed start");
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
                errorCodes.coreWorkerStartFailed,
            );
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "stopped");
        assert.equal(snapshot.connectionState, "disconnected");
        assert.equal(snapshot.ready, false);
        assert.equal(snapshot.lastErrorCode, errorCodes.coreWorkerStartFailed);
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
                errorCodes.coreWorkerStopFailed,
            );
            return true;
        });

        const snapshot = instance.snapshot();
        assert.equal(snapshot.daemonState, "running");
        assert.equal(snapshot.connectionState, "connected");
        assert.equal(snapshot.ready, true);
        assert.equal(snapshot.lastErrorCode, errorCodes.coreWorkerStopFailed);
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
                "worker.rpcConnected",
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
                "worker.rpcConnected",
                "worker.schemaRefreshed",
                "instance.started",
                "instance.statusChanged",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.rpcDisconnected",
                "instance.connectionChanged",
                "instance.readyChanged",
                "worker.rpcConnected",
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
    const pending = new Map<string, string[]>();
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
              protocol: FrameProtocol;
              stream?: FrameStream;
          }
        | undefined;

    const transport: WorkerTransport = {
        async connectWorkerChannel() {
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
            const protocol = new FrameProtocol(server, { role: "acceptor" });
            const connection = { protocol } as {
                protocol: FrameProtocol;
                stream?: FrameStream;
            };
            activeConnection = connection;
            void serveRpcHarness(connection).catch((error: unknown) => {
                protocol.close(
                    error instanceof Error ? error : new Error(String(error)),
                );
            });
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

    async function serveRpcHarness(connection: {
        protocol: FrameProtocol;
        stream?: FrameStream;
    }): Promise<void> {
        const open = await connection.protocol.nextOpen();
        assert.notEqual(open, undefined);
        assert.equal(open!.service, "worker.rpc");
        assert.equal(open!.metadata.byteLength, 0);
        const stream = await open!.accept();
        connection.stream = stream;
        const reader = new PacketBuffer();

        while (true) {
            const chunk = await stream.read();
            if (chunk === undefined) return;
            for (const payload of reader.push(chunk)) {
                const frame = decodeWorkerRpcMessage(payload);
                if (!isRequestFrame(frame)) continue;

                const pendingIds = pending.get(frame.method) ?? [];
                pendingIds.push(frame.id);
                pending.set(frame.method, pendingIds);
                requestMethods.push(frame.method);
                methodWaiters
                    .get(frame.method)
                    ?.splice(0)
                    .forEach((resolve) => resolve());

                if (
                    frame.method === "worker.ping" ||
                    frame.method === "worker.handshake" ||
                    frame.method === "tools.list"
                ) {
                    await stream.write(
                        encodePacket(
                            encodeWorkerRpcMessage(
                                createLifecycleResponse(
                                    frame.method,
                                    frame.id,
                                    tools,
                                ) as unknown as JsonValue,
                            ),
                        ),
                    );
                }
            }
        }
    }

    function writeToActiveStream(value: JsonValue): void {
        const stream = activeConnection?.stream;
        if (stream === undefined) {
            throw new Error("worker.rpc lifecycle harness stream is not connected.");
        }
        void stream
            .write(encodePacket(encodeWorkerRpcMessage(value)))
            .catch(() => undefined);
    }

    return {
        disconnect() {
            activeConnection?.protocol.close(
                new Error("injected rpc transport disconnect"),
            );
            activeConnection = undefined;
        },
        fail(method, code) {
            const requestIds = pending.get(method);
            if (requestIds === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }
            const requestId = requestIds.shift();
            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }
            if (requestIds.length === 0) {
                pending.delete(method);
            }
            writeToActiveStream({
                error: {
                    code,
                    message: `worker rejected ${method}`,
                    retryable: false,
                },
                id: requestId,
                ok: false,
                type: "response",
            } as unknown as JsonValue);
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
            const requestIds = pending.get(method);
            if (requestIds === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }
            const requestId = requestIds.shift();
            if (requestId === undefined) {
                throw new Error(`No pending request for ${method}.`);
            }

            if (requestIds.length === 0) {
                pending.delete(method);
            }

            writeToActiveStream({
                id: requestId,
                ok: true,
                result,
                type: "response",
            } as unknown as JsonValue);
        },
        setStatus(status) {
            commandStatus = status;
        },
        waitForMethod(method) {
            if (requestMethods.includes(method)) {
                return Promise.resolve();
            }

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
            ) {
                return Promise.resolve();
            }

            return new Promise<void>((resolve) => {
                const observe = () => {
                    if (
                        requestMethods.filter((value) => value === method)
                            .length >= count
                    ) {
                        resolve();
                        return;
                    }

                    const waiters = methodWaiters.get(method) ?? [];
                    waiters.push(observe);
                    methodWaiters.set(method, waiters);
                };

                observe();
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

function isRequestFrame(
    value: unknown,
): value is { id: string; method: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
        candidate.type === "request" &&
        typeof candidate.id === "string" &&
        typeof candidate.method === "string"
    );
}

function createLifecycleResponse(
    method: string,
    id: string,
    tools: HarnessTool[],
): WorkerRpcResponseEnvelope {
    if (method === "worker.ping") {
        return {
            id,
            ok: true,
            result: { pong: true },
            type: "response",
        };
    }

    if (method === "worker.handshake") {
        return {
            id,
            ok: true,
            result: {
                capabilities: { cancel: true, streaming: false, tools: true },
                instance: "task-6-harness",
                platform: { arch: "x64", os: "linux" },
                protocolVersion: WORKER_PROTOCOL_VERSION,
                workerVersion: "0.1.0",
                workspace: "/tmp/workspace",
            },
            type: "response",
        };
    }

    return {
        id,
        ok: true,
        result: {
            tools,
        },
        type: "response",
    };
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

async function waitForPendingApproval(
    instance: ReturnType<WorkerInstanceFactory["create"]>,
): Promise<{ approvalId: string }> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
        const approval = (await instance.listApprovals()).find(
            (candidate) => candidate.status === "pending",
        );
        if (approval !== undefined) {
            return { approvalId: approval.approvalId };
        }
        await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error("Timed out waiting for a pending approval.");
}

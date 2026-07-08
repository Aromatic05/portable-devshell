import { createConnection } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import { ControlDaemon, type ControlDaemonSpawnOptions } from "./ControlDaemon.js";
import { ControlLogger } from "./ControlLogger.js";
import { ControlPidFile } from "./ControlPidFile.js";
import { ControlSocketFile } from "./ControlSocketFile.js";

export interface ControlLifecycleStatus {
    instanceCount: number;
    pid?: number;
    running: boolean;
}

export interface ControlLifecycleRpcClient {
    request(method: string, params?: JsonValue): Promise<JsonValue>;
}

export interface ControlLifecycleManagerOptions extends ControlDaemonSpawnOptions {
    logger?: ControlLogger;
    pidFile?: ControlPidFile;
    rpcClient?: ControlLifecycleRpcClient;
    socketFile?: ControlSocketFile;
    waitTimeoutMs?: number;
}

export class ControlLifecycleManager {
    readonly #logger: ControlLogger;
    readonly #pidFile: ControlPidFile;
    readonly #rpcClient: ControlLifecycleRpcClient;
    readonly #socketFile: ControlSocketFile;
    readonly #waitTimeoutMs: number;
    readonly #spawnOptions: ControlDaemonSpawnOptions;

    constructor(options: ControlLifecycleManagerOptions = {}) {
        this.#logger = options.logger ?? new ControlLogger(options.homeDirectory);
        this.#pidFile = options.pidFile ?? new ControlPidFile(options.homeDirectory);
        this.#socketFile = options.socketFile ?? new ControlSocketFile(options.xdgRuntimeDir);
        this.#waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
        this.#spawnOptions = {
            daemonModulePath: options.daemonModulePath,
            env: options.env,
            homeDirectory: options.homeDirectory,
            spawnFunction: options.spawnFunction,
            xdgRuntimeDir: options.xdgRuntimeDir
        };
        this.#rpcClient = options.rpcClient ?? new SocketControlLifecycleRpcClient(this.#socketFile.path);
    }

    async start(): Promise<ControlLifecycleStatus> {
        const current = await this.status();

        if (current.running) {
            return current;
        }

        await this.#pidFile.remove();
        await this.#socketFile.remove();
        await this.#socketFile.ensureRuntimeDir();
        ControlDaemon.spawnDetached(this.#spawnOptions);

        return await this.#waitFor(async () => {
            const next = await this.status();
            return next.running ? next : undefined;
        }, "control server did not become ready");
    }

    async stop(): Promise<ControlLifecycleStatus> {
        const current = await this.status();

        if (current.running) {
            try {
                await this.#rpcClient.request("control.shutdown");
            } catch {
                // The daemon may close the socket before the client observes the response.
            }
            await this.#waitFor(async () => {
                const next = await this.status();
                return next.running ? undefined : next;
            }, "control server did not stop");
        }

        await this.#pidFile.remove();
        await this.#socketFile.remove();
        return await this.status();
    }

    async status(): Promise<ControlLifecycleStatus> {
        const pid = await this.#pidFile.read();

        try {
            const result = await this.#rpcClient.request("control.status");

            if (!isJsonRecord(result) || typeof result.instanceCount !== "number") {
                throw new Error("Invalid control.status response.");
            }

            return {
                instanceCount: result.instanceCount,
                pid,
                running: true
            };
        } catch {
            return {
                instanceCount: 0,
                pid,
                running: false
            };
        }
    }

    async logs(): Promise<string> {
        return await this.#logger.readAll();
    }

    async #waitFor<T>(factory: () => Promise<T | undefined>, timeoutMessage: string): Promise<T> {
        const deadline = Date.now() + this.#waitTimeoutMs;

        while (Date.now() < deadline) {
            const value = await factory();

            if (value !== undefined) {
                return value;
            }

            await sleep(50);
        }

        throw new Error(timeoutMessage);
    }
}

class SocketControlLifecycleRpcClient implements ControlLifecycleRpcClient {
    readonly #socketPath: string;

    constructor(socketPath: string) {
        this.#socketPath = socketPath;
    }

    async request(method: string, params?: JsonValue): Promise<JsonValue> {
        const socket = createConnection(this.#socketPath);
        const reader = new FrameReader();
        const writer = new FrameWriter(socket);
        let settled = false;
        let resolveResponse: (value: JsonValue) => void = () => undefined;
        let rejectResponse: (reason?: unknown) => void = () => undefined;

        const resolveOnce = (value: JsonValue): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.end();
            resolveResponse(value);
        };

        const rejectOnce = (error: unknown): void => {
            if (settled) {
                return;
            }

            settled = true;
            socket.destroy();
            rejectResponse(error);
        };

        await new Promise<void>((resolve, reject) => {
            socket.once("connect", resolve);
            socket.once("error", reject);
        });

        const response = new Promise<JsonValue>((resolve, reject) => {
            resolveResponse = resolve;
            rejectResponse = reject;

            socket.on("data", (chunk: Uint8Array) => {
                for (const frame of reader.push(chunk)) {
                    if (!isJsonRecord(frame) || frame.type !== "response") {
                        continue;
                    }

                    if (frame.ok !== true) {
                        rejectOnce(
                            new Error(
                                isJsonRecord(frame.error) && typeof frame.error.message === "string"
                                    ? frame.error.message
                                    : "control request failed"
                            )
                        );
                        return;
                    }

                    resolveOnce((frame.result ?? null) as JsonValue);
                }
            });
            socket.once("error", (error) => {
                rejectOnce(error);
            });
            socket.once("close", () => {
                rejectOnce(new Error("control connection closed"));
            });
        });

        try {
            await writer.write({
                id: `${method}-${Date.now()}`,
                issuedAt: new Date().toISOString(),
                method,
                params,
                target: { kind: "control" },
                type: "request"
            } as unknown as JsonValue);
        } catch (error) {
            rejectOnce(error);
        }

        try {
            return await response;
        } finally {
            socket.destroy();
        }
    }
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

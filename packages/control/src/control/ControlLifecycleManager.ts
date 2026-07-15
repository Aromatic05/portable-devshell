import { setTimeout as sleep } from "node:timers/promises";

import {
    ProtocolControlClientConnection,
    createControlTarget,
    type ControlResponseEnvelope,
    type JsonValue
} from "@portable-devshell/shared";

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
    request(method: "control.shutdown" | "control.status"): Promise<JsonValue>;
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
        this.#rpcClient = options.rpcClient ?? createSocketControlLifecycleRpcClient(this.#socketFile.path);
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

        try {
            return await this.#waitFor(async () => {
                const next = await this.status();
                return next.running ? next : undefined;
            }, "control server did not become ready");
        } catch (error) {
            throw new Error(await this.#renderStartFailure(error));
        }
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

    async #renderStartFailure(error: unknown): Promise<string> {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const logs = await this.logs();
        const tail = tailLines(logs, 80);

        if (tail.length === 0) {
            return baseMessage;
        }

        return `${baseMessage}\ncontrol log:\n${tail}`;
    }
}

function createSocketControlLifecycleRpcClient(socketPath: string): ControlLifecycleRpcClient {
    return {
        async request(method) {
            const connection = new ProtocolControlClientConnection<null, Error>({
                connectionClosedMessage: null,
                mapConnectionError: toError,
                mapRemoteError: toRemoteError,
                mapStreamMessage: () => null,
                requestIdPrefix: "lifecycle",
                socketPath
            });
            try {
                return await connection.request(method, createControlTarget()) as unknown as JsonValue;
            } finally {
                connection.close();
            }
        }
    };
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function toRemoteError(response: ControlResponseEnvelope): Error {
    return new Error(response.error?.message ?? "control request failed");
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tailLines(source: string, limit: number): string {
    const lines = source
        .trim()
        .split("\n")
        .filter((line) => line.length > 0);

    if (lines.length === 0) {
        return "";
    }

    return lines.slice(-limit).join("\n");
}

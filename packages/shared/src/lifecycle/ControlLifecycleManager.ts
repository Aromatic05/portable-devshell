import { setTimeout as sleep } from "node:timers/promises";

import { createError } from "../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { Channel } from "../transport/Channel.js";
import { Codec } from "../transport/Codec.js";
import { PrefixRoute } from "../transport/PrefixRoute.js";

import { ControlDaemonLauncher, type ControlDaemonLaunchOptions } from "./ControlDaemonLauncher.js";
import { ControlLogger } from "./ControlLogger.js";
import { ControlPidFile } from "./ControlPidFile.js";
import { ControlSocketFile } from "./ControlSocketFile.js";

export interface ControlLifecycleStatus {
    instanceCount: number;
    pid?: number;
    running: boolean;
}

export interface ControlLifecycleRpcClient {
    request(operation: "shutdown" | "status"): Promise<JsonValue>;
}

export interface ControlLifecycleManagerOptions extends Partial<ControlDaemonLaunchOptions> {
    logger?: ControlLogger;
    pidFile?: ControlPidFile;
    rpcClient?: ControlLifecycleRpcClient;
    socketFile?: ControlSocketFile;
    waitTimeoutMs?: number;
}

export class ControlLifecycleManager {
    readonly #launchOptions: Partial<ControlDaemonLaunchOptions>;
    readonly #logger: ControlLogger;
    readonly #pidFile: ControlPidFile;
    readonly #rpcClient: ControlLifecycleRpcClient;
    readonly #socketFile: ControlSocketFile;
    readonly #waitTimeoutMs: number;

    constructor(options: ControlLifecycleManagerOptions = {}) {
        this.#logger = options.logger ?? new ControlLogger(options.homeDirectory);
        this.#pidFile = options.pidFile ?? new ControlPidFile(options.homeDirectory);
        this.#socketFile = options.socketFile ?? new ControlSocketFile(options.xdgRuntimeDir);
        this.#waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
        this.#launchOptions = {
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
        if (current.running) return current;
        await this.#pidFile.remove();
        await this.#socketFile.remove();
        await this.#socketFile.ensureRuntimeDir();
        const daemonModulePath = this.#launchOptions.daemonModulePath;
        if (daemonModulePath === undefined) {
            throw new Error("Control lifecycle start requires daemonModulePath.");
        }
        ControlDaemonLauncher.spawnDetached({
            ...this.#launchOptions,
            daemonModulePath
        });
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
                await this.#rpcClient.request("shutdown");
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
            const result = await this.#rpcClient.request("status");
            if (!isJsonRecord(result) || typeof result.instanceCount !== "number") {
                throw new Error("Invalid service.status response.");
            }
            return { instanceCount: result.instanceCount, pid, running: true };
        } catch {
            return { instanceCount: 0, pid, running: false };
        }
    }

    async logs(): Promise<string> {
        return await this.#logger.readAll();
    }

    async #waitFor<T>(factory: () => Promise<T | undefined>, timeoutMessage: string): Promise<T> {
        const deadline = Date.now() + this.#waitTimeoutMs;
        while (Date.now() < deadline) {
            const value = await factory();
            if (value !== undefined) return value;
            await sleep(50);
        }
        throw new Error(timeoutMessage);
    }

    async #renderStartFailure(error: unknown): Promise<string> {
        const baseMessage = error instanceof Error ? error.message : String(error);
        const tail = tailLines(await this.logs(), 80);
        return tail.length === 0 ? baseMessage : `${baseMessage}\ncontrol log:\n${tail}`;
    }
}

function createSocketControlLifecycleRpcClient(socketPath: string): ControlLifecycleRpcClient {
    return {
        async request(operation) {
            const channel = await Channel.connect(socketPath);
            const route = new PrefixRoute(new Codec(channel, { local: "cli", remote: "server" }), {
                requestIdPrefix: "lifecycle"
            });
            try {
                const reply = await route.request({
                    destination: "@control",
                    name: `service.${operation}`
                });
                if (reply.event.error !== undefined) throw createError(reply.event.error);
                return reply.event.payload as JsonValue;
            } finally {
                route.close();
            }
        }
    };
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tailLines(source: string, limit: number): string {
    const lines = source.trim().split("\n").filter((line) => line.length > 0);
    return lines.length === 0 ? "" : lines.slice(-limit).join("\n");
}

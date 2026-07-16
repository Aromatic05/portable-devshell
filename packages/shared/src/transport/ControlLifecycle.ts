import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { createError } from "../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../type/TypeJsonValue.js";
import { ClientConnection } from "./ClientConnection.js";
import {
    ControlPathHome,
    ControlSocketFile,
    type ControlSocketFilePort
} from "./ControlEndpoint.js";

export interface ControlDaemonLaunchOptions {
    daemonModulePath: string;
    env?: NodeJS.ProcessEnv;
    homeDirectory?: string;
    spawnFunction?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    xdgRuntimeDir?: string;
}

export interface ControlLifecycleStatus {
    instanceCount: number;
    pid?: number;
    running: boolean;
}

export interface ControlLifecycleRpcClient {
    request(operation: "shutdown" | "status"): Promise<JsonValue>;
}

export interface ControlLoggerPort {
    readonly path: string;
    error(message: string): Promise<void>;
    info(message: string): Promise<void>;
    readAll(): Promise<string>;
}

export interface ControlPidFilePort {
    readonly path: string;
    read(): Promise<number | undefined>;
    remove(): Promise<void>;
    write(pid?: number): Promise<void>;
}

export interface ControlLifecycleManagerOptions extends Partial<ControlDaemonLaunchOptions> {
    logger?: ControlLoggerPort;
    pidFile?: ControlPidFilePort;
    rpcClient?: ControlLifecycleRpcClient;
    socketFile?: ControlSocketFilePort;
    waitTimeoutMs?: number;
}

export class ControlDaemonLauncher {
    static spawnDetached(options: ControlDaemonLaunchOptions): ChildProcess {
        const spawnFunction = options.spawnFunction ?? spawn;
        const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
        if (options.homeDirectory !== undefined) {
            env.HOME = options.homeDirectory;
            if (process.platform === "win32") {
                env.USERPROFILE = options.homeDirectory;
            }
        }
        if (options.xdgRuntimeDir !== undefined) {
            env.XDG_RUNTIME_DIR = options.xdgRuntimeDir;
        }
        const child = spawnFunction(
            process.execPath,
            [...collectNodeBootstrapArgs(process.execArgv), options.daemonModulePath],
            { detached: true, env, stdio: "ignore" }
        );
        child.unref();
        return child;
    }
}

export class ControlLogger implements ControlLoggerPort {
    readonly #logsDir: string;
    readonly path: string;

    constructor(homeDirectory?: string) {
        this.#logsDir = join(new ControlPathHome(homeDirectory).controlHomeDir, "logs");
        this.path = join(this.#logsDir, "control.log");
    }

    async info(message: string): Promise<void> {
        await this.write("INFO", message);
    }

    async error(message: string): Promise<void> {
        await this.write("ERROR", message);
    }

    async readAll(): Promise<string> {
        try {
            return await readFile(this.path, "utf8");
        } catch (error) {
            if (isFileMissingError(error)) {
                return "";
            }
            throw error;
        }
    }

    async write(level: string, message: string): Promise<void> {
        await mkdir(this.#logsDir, { recursive: true });
        await appendFile(this.path, `[${new Date().toISOString()}] ${level} ${message}\n`, "utf8");
    }
}

export class ControlPidFile implements ControlPidFilePort {
    readonly path: string;

    constructor(homeDirectory?: string) {
        this.path = join(new ControlPathHome(homeDirectory).controlHomeDir, "control.pid");
    }

    async read(): Promise<number | undefined> {
        try {
            const source = (await readFile(this.path, "utf8")).trim();
            const pid = Number.parseInt(source, 10);
            return source.length > 0 && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
        } catch (error) {
            if (isFileMissingError(error)) {
                return undefined;
            }
            throw error;
        }
    }

    async write(pid = process.pid): Promise<void> {
        await mkdir(dirname(this.path), { recursive: true });
        await writeFile(this.path, `${pid}\n`, "utf8");
    }

    async remove(): Promise<void> {
        await rm(this.path, { force: true });
    }
}

export class ControlLifecycleManager {
    readonly #launchOptions: Partial<ControlDaemonLaunchOptions>;
    readonly #logger: ControlLoggerPort;
    readonly #pidFile: ControlPidFilePort;
    readonly #rpcClient: ControlLifecycleRpcClient;
    readonly #socketFile: ControlSocketFilePort;
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
        if (current.running) {
            return current;
        }
        await this.#pidFile.remove();
        await this.#socketFile.remove();
        await this.#socketFile.ensureRuntimeDir();
        const daemonModulePath = this.#launchOptions.daemonModulePath;
        if (daemonModulePath === undefined) {
            throw new Error("Control lifecycle start requires daemonModulePath.");
        }
        ControlDaemonLauncher.spawnDetached({ ...this.#launchOptions, daemonModulePath });
        try {
            return await this.#waitFor(async () => {
                const status = await this.status();
                return status.running ? status : undefined;
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
                // The daemon may close the socket before the response reaches the client.
            }
            await this.#waitFor(async () => {
                const status = await this.status();
                return status.running ? undefined : status;
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
            if (value !== undefined) {
                return value;
            }
            await sleep(50);
        }
        throw new Error(timeoutMessage);
    }

    async #renderStartFailure(error: unknown): Promise<string> {
        const message = error instanceof Error ? error.message : String(error);
        const tail = tailLines(await this.logs(), 80);
        return tail.length === 0 ? message : `${message}\ncontrol log:\n${tail}`;
    }
}

function createSocketControlLifecycleRpcClient(socketPath: string): ControlLifecycleRpcClient {
    const connection = new ClientConnection({
        mapError: toError,
        mapRemoteError: (error) => createError(error),
        mode: "short",
        peer: "cli",
        socketPath
    });
    return {
        request: async (operation) => await connection.request("@control", "service", operation)
    };
}

function collectNodeBootstrapArgs(execArgv: readonly string[]): string[] {
    const args: string[] = [];
    for (let index = 0; index < execArgv.length; index += 1) {
        const current = execArgv[index]!;
        if ((current === "--import" || current === "--loader") && execArgv[index + 1] !== undefined) {
            args.push(current, execArgv[index + 1]!);
            index += 1;
        } else if (current.startsWith("--import=") || current.startsWith("--loader=")) {
            args.push(current);
        }
    }
    return args;
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tailLines(source: string, limit: number): string {
    const lines = source.trim().split("\n").filter((line) => line.length > 0);
    return lines.length === 0 ? "" : lines.slice(-limit).join("\n");
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

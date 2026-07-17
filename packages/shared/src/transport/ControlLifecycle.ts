import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { appendFile, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
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

interface ControlLifecycleProbe {
    status: ControlLifecycleStatus;
    verifiedPid?: number;
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
    processIsRunning?: (pid: number) => boolean;
    requestTimeoutMs?: number;
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
    readonly #lifecycleLock: ControlLifecycleFileLock;
    readonly #logger: ControlLoggerPort;
    readonly #pidFile: ControlPidFilePort;
    readonly #processIsRunning: (pid: number) => boolean;
    readonly #rpcClient: ControlLifecycleRpcClient;
    readonly #socketFile: ControlSocketFilePort;
    readonly #waitTimeoutMs: number;

    constructor(options: ControlLifecycleManagerOptions = {}) {
        this.#logger = options.logger ?? new ControlLogger(options.homeDirectory);
        this.#pidFile = options.pidFile ?? new ControlPidFile(options.homeDirectory);
        this.#socketFile = options.socketFile ?? new ControlSocketFile(options.xdgRuntimeDir);
        this.#waitTimeoutMs = options.waitTimeoutMs ?? 5_000;
        this.#processIsRunning = options.processIsRunning ?? processIsRunning;
        this.#launchOptions = {
            daemonModulePath: options.daemonModulePath,
            env: options.env,
            homeDirectory: options.homeDirectory,
            spawnFunction: options.spawnFunction,
            xdgRuntimeDir: options.xdgRuntimeDir
        };
        this.#rpcClient = options.rpcClient ?? createSocketControlLifecycleRpcClient(
            this.#socketFile.path,
            options.requestTimeoutMs ?? Math.min(this.#waitTimeoutMs, 1_000)
        );
        const lifecycleLockDirectory = this.#socketFile.runtimeDir ?? dirname(this.#pidFile.path);
        this.#lifecycleLock = new ControlLifecycleFileLock(
            join(lifecycleLockDirectory, "control.lifecycle.lock"),
            this.#processIsRunning,
            this.#waitTimeoutMs
        );
    }

    async start(): Promise<ControlLifecycleStatus> {
        return await this.#lifecycleLock.runExclusive(async () => {
            const current = (await this.#probeStatus()).status;
            if (current.running) {
                return current;
            }
            if (current.pid !== undefined && this.#processIsRunning(current.pid)) {
                throw new Error(
                    `Control PID file points to live process ${current.pid}, but the control RPC endpoint is unavailable. Refusing to replace an unverified process; terminate it manually after confirming its identity.`
                );
            }

            await this.#cleanupRuntimeFiles(current.pid);
            await this.#socketFile.ensureRuntimeDir();
            const daemonModulePath = this.#launchOptions.daemonModulePath;
            if (daemonModulePath === undefined) {
                throw new Error("Control lifecycle start requires daemonModulePath.");
            }

            const child = ControlDaemonLauncher.spawnDetached({ ...this.#launchOptions, daemonModulePath });
            const pid = child.pid;
            if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
                throw new Error("Control daemon spawn did not return a process id.");
            }

            try {
                await this.#pidFile.write(pid);
                return await this.#waitFor(async () => {
                    const status = await this.status();
                    if (status.running) {
                        return status;
                    }
                    if (!this.#processIsRunning(pid)) {
                        throw new Error(`control server process ${pid} exited before becoming ready`);
                    }
                    return undefined;
                }, "control server did not become ready");
            } catch (error) {
                await this.#terminateProcess(pid).catch(() => undefined);
                await this.#cleanupRuntimeFiles(pid);
                throw new Error(await this.#renderStartFailure(error));
            }
        });
    }

    async stop(): Promise<ControlLifecycleStatus> {
        return await this.#lifecycleLock.runExclusive(async () => {
            const probe = await this.#probeStatus();
            const current = probe.status;
            const pid = current.pid;
            if (current.running) {
                try {
                    await this.#rpcClient.request("shutdown");
                } catch {
                    // The daemon may close the connection before the response reaches the client.
                }
            }

            if (pid !== undefined && this.#processIsRunning(pid)) {
                if (!current.running) {
                    throw new Error(
                        `Control PID file points to live process ${pid}, but the control RPC endpoint is unavailable. Refusing to signal an unverified process.`
                    );
                }
                if (probe.verifiedPid !== undefined) {
                    try {
                        await this.#waitForProcessExit(pid, "control server did not stop");
                    } catch {
                        await this.#terminateProcess(pid);
                    }
                } else {
                    await this.#waitForProcessExit(
                        pid,
                        `control server process ${pid} did not stop; its PID could not be verified over RPC`
                    );
                }
            } else if (current.running) {
                await this.#waitFor(async () => {
                    const status = await this.status();
                    return status.running ? undefined : true;
                }, "control server did not stop");
            }

            await this.#cleanupRuntimeFiles(pid);
            return await this.status();
        });
    }

    async status(): Promise<ControlLifecycleStatus> {
        return (await this.#probeStatus()).status;
    }

    async #probeStatus(): Promise<ControlLifecycleProbe> {
        const recordedPid = await this.#pidFile.read();
        try {
            const result = await this.#rpcClient.request("status");
            if (!isJsonRecord(result) || typeof result.instanceCount !== "number") {
                throw new Error("Invalid service.status response.");
            }
            const reportedPid = isPositiveInteger(result.pid) ? result.pid : undefined;
            return {
                status: {
                    instanceCount: result.instanceCount,
                    pid: reportedPid ?? recordedPid,
                    running: true
                },
                verifiedPid: reportedPid
            };
        } catch {
            return {
                status: { instanceCount: 0, pid: recordedPid, running: false }
            };
        }
    }

    async logs(): Promise<string> {
        return await this.#logger.readAll();
    }

    async #cleanupRuntimeFiles(expectedPid: number | undefined): Promise<void> {
        const currentPid = await this.#pidFile.read();
        if (expectedPid !== undefined && currentPid !== undefined && currentPid !== expectedPid) {
            return;
        }
        await this.#pidFile.remove();
        await this.#socketFile.remove();
    }

    async #terminateProcess(pid: number): Promise<void> {
        if (!this.#processIsRunning(pid)) {
            return;
        }
        sendSignal(pid, "SIGTERM");
        try {
            await this.#waitForProcessExit(pid, `control process ${pid} did not terminate`);
            return;
        } catch {
            sendSignal(pid, "SIGKILL");
        }
        await this.#waitForProcessExit(pid, `control process ${pid} did not terminate after SIGKILL`);
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

    async #waitForProcessExit(pid: number, timeoutMessage: string): Promise<void> {
        await this.#waitFor(async () => this.#processIsRunning(pid) ? undefined : true, timeoutMessage);
    }

    async #renderStartFailure(error: unknown): Promise<string> {
        const message = error instanceof Error ? error.message : String(error);
        const tail = tailLines(await this.logs(), 80);
        return tail.length === 0 ? message : `${message}\ncontrol log:\n${tail}`;
    }
}

class ControlLifecycleFileLock {
    readonly #path: string;
    readonly #processIsRunning: (pid: number) => boolean;
    readonly #waitTimeoutMs: number;

    constructor(path: string, processIsRunningFactory: (pid: number) => boolean, waitTimeoutMs: number) {
        this.#path = path;
        this.#processIsRunning = processIsRunningFactory;
        this.#waitTimeoutMs = waitTimeoutMs;
    }

    async runExclusive<T>(factory: () => Promise<T>): Promise<T> {
        const release = await this.#acquire();
        try {
            return await factory();
        } finally {
            await release();
        }
    }

    async #acquire(): Promise<() => Promise<void>> {
        await mkdir(dirname(this.#path), { recursive: true });
        const deadline = Date.now() + this.#waitTimeoutMs;
        while (Date.now() < deadline) {
            try {
                const handle = await open(this.#path, "wx", 0o600);
                try {
                    await handle.writeFile(`${process.pid}\n`, "utf8");
                } finally {
                    await handle.close();
                }
                return async () => {
                    if (await readPositiveInteger(this.#path) === process.pid) {
                        await rm(this.#path, { force: true });
                    }
                };
            } catch (error) {
                if (!isFileExistsError(error)) {
                    throw error;
                }
            }

            const ownerPid = await readPositiveInteger(this.#path);
            if (ownerPid !== undefined && !this.#processIsRunning(ownerPid)) {
                await rm(this.#path, { force: true });
                continue;
            }
            if (ownerPid === undefined && await fileAgeMs(this.#path) > this.#waitTimeoutMs) {
                await rm(this.#path, { force: true });
                continue;
            }
            await sleep(50);
        }
        throw new Error(`Timed out waiting for control lifecycle lock ${this.#path}.`);
    }
}

function createSocketControlLifecycleRpcClient(
    socketPath: string,
    requestTimeoutMs: number
): ControlLifecycleRpcClient {
    const connection = new ClientConnection({
        mapError: toError,
        mapRemoteError: (error) => createError(error),
        mode: "short",
        peer: "cli",
        socketFactory: (path) => {
            const socket = createConnection(path);
            socket.setTimeout(requestTimeoutMs, () => {
                socket.destroy(new Error(`Control RPC request timed out after ${requestTimeoutMs}ms.`));
            });
            return socket;
        },
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

async function fileAgeMs(path: string): Promise<number> {
    try {
        return Date.now() - (await stat(path)).mtimeMs;
    } catch (error) {
        return isFileMissingError(error) ? 0 : Number.POSITIVE_INFINITY;
    }
}

function isFileExistsError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isFileMissingError(error: unknown): error is NodeJS.ErrnoException {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isJsonRecord(value: JsonValue): value is { [key: string]: JsonValue } {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveInteger(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function processIsRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
    }
}

async function readPositiveInteger(path: string): Promise<number | undefined> {
    try {
        const source = (await readFile(path, "utf8")).trim();
        const value = Number.parseInt(source, 10);
        return source.length > 0 && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    } catch (error) {
        if (isFileMissingError(error)) {
            return undefined;
        }
        throw error;
    }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
    try {
        process.kill(pid, signal);
    } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH")) {
            throw error;
        }
    }
}

function tailLines(source: string, limit: number): string {
    const lines = source.trim().split("\n").filter((line) => line.length > 0);
    return lines.length === 0 ? "" : lines.slice(-limit).join("\n");
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

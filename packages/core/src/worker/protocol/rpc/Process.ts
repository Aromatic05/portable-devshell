import type { ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";

import {
    createError,
    errorCodes,
    StreamChannel,
    type Channel,
} from "@portable-devshell/shared";
import {
    FrameProtocol,
    FrameStreamChannel,
} from "@portable-devshell/shared/transport/frame";

import type { WorkerTransport } from "../../transport/Transport.js";
import type { WorkerRpcOptions } from "../../transport/command/Model.js";
import type { WorkerRpcConnector } from "./connection/Bridge.js";

export interface WorkerRpcExitResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

export interface WorkerRpcProcess {
    readonly stdin: Writable | null;
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    readonly exit: Promise<WorkerRpcExitResult>;
}

export function createWorkerRpcProcess(child: ChildProcess): WorkerRpcProcess {
    return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        kill(signal) {
            return child.kill(signal);
        },
        exit: new Promise<WorkerRpcExitResult>((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", (code, signal) => {
                resolve({ code, signal });
            });
        }),
    };
}

export class WorkerRpcProcessAdapter {
    readonly #process: WorkerRpcProcess;

    constructor(process: WorkerRpcProcess) {
        if (
            process.stdin === null ||
            process.stdout === null ||
            process.stderr === null
        ) {
            throw createError({
                code: errorCodes.coreWorkerRpcSpawnFailed,
                message:
                    "Worker RPC process must expose stdin, stdout, and stderr.",
                retryable: false,
            });
        }

        this.#process = process;
    }

    static async spawn(
        transport: WorkerTransport,
        options: WorkerRpcOptions,
        signal?: AbortSignal,
    ): Promise<WorkerRpcProcessAdapter> {
        if (signal?.aborted === true) {
            throw abortError(signal);
        }
        const spawning = WorkerRpcProcessAdapter.#spawnProcess(
            transport,
            options,
            signal,
        );
        if (signal === undefined) {
            return await spawning;
        }
        let onAbort!: () => void;
        const aborted = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(abortError(signal));
            signal.addEventListener("abort", onAbort, { once: true });
        });
        if (signal.aborted) onAbort();
        try {
            return await Promise.race([spawning, aborted]);
        } finally {
            signal.removeEventListener("abort", onAbort);
        }
    }

    static async #spawnProcess(
        transport: WorkerTransport,
        options: WorkerRpcOptions,
        signal?: AbortSignal,
    ): Promise<WorkerRpcProcessAdapter> {
        try {
            const process = await transport.spawnWorkerRpc(options);
            if (signal?.aborted === true) {
                try {
                    process.kill("SIGTERM");
                } catch {
                    // The cancelled spawn is already rejected; late process cleanup is best effort.
                }
                throw abortError(signal);
            }
            return new WorkerRpcProcessAdapter(process);
        } catch (error) {
            if (signal?.aborted === true) {
                throw abortError(signal);
            }
            if (
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                error.code === errorCodes.coreWorkerRpcSpawnFailed
            ) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerRpcSpawnFailed,
                cause: error,
                details: { instance: options.instanceName },
                message: `Worker RPC spawn failed for instance ${options.instanceName}.`,
                retryable: false,
            });
        }
    }

    get stdin(): Writable {
        return this.#process.stdin as Writable;
    }

    get stdout(): Readable {
        return this.#process.stdout as Readable;
    }

    get stderr(): Readable {
        return this.#process.stderr as Readable;
    }

    get exit(): Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
    }> {
        return this.#process.exit;
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        return this.#process.kill(signal);
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Worker RPC connection was aborted.");
}

export class WorkerRpcProcessConnector implements WorkerRpcConnector {
    readonly #transport: WorkerTransport;
    readonly #options: WorkerRpcOptions;

    constructor(transport: WorkerTransport, options: WorkerRpcOptions) {
        this.#transport = transport;
        this.#options = options;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        const process = await WorkerRpcProcessAdapter.spawn(
            this.#transport,
            this.#options,
            signal,
        );
        const channel = new StreamChannel(process.stdout, process.stdin, {
            closeTransport: () => {
                process.kill("SIGTERM");
            },
        });
        void process.exit.then(
            (result) =>
                channel.close(
                    new Error(
                        `rpc process exited with code ${String(result.code)} signal ${String(result.signal)}`,
                    ),
                ),
            (error) =>
                channel.close(
                    error instanceof Error ? error : new Error(String(error)),
                ),
        );
        return channel;
    }
}

export class WorkerRpcTransportConnector implements WorkerRpcConnector {
    readonly #transport: WorkerTransport;
    readonly #options: WorkerRpcOptions;

    constructor(transport: WorkerTransport, options: WorkerRpcOptions) {
        this.#transport = transport;
        this.#options = options;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        throwIfAborted(signal);
        let transportChannel: Channel;
        try {
            transportChannel = await this.#transport.connectWorkerChannel(
                this.#options,
            );
        } catch (error) {
            throw this.#connectError(error);
        }
        if (signal?.aborted === true) {
            transportChannel.close();
            throw abortError(signal);
        }

        const protocol = new FrameProtocol(transportChannel, { role: "opener" });
        try {
            const stream = await protocol.open("worker.rpc");
            if (isAborted(signal)) {
                protocol.close();
                throw abortError(signal);
            }
            return new FrameStreamChannel(stream, {
                closeTransport: (error) => protocol.close(error),
            });
        } catch (error) {
            protocol.close(
                error instanceof Error ? error : new Error(String(error)),
            );
            if (isAborted(signal)) throw abortError(signal);
            throw this.#connectError(error);
        }
    }

    #connectError(error: unknown): Error {
        if (
            error instanceof Error &&
            "code" in error &&
            error.code === errorCodes.coreWorkerRpcSpawnFailed
        ) {
            return error;
        }
        return createError({
            code: errorCodes.coreWorkerRpcSpawnFailed,
            cause: error,
            details: { instance: this.#options.instanceName },
            message: `Worker RPC connection failed for instance ${this.#options.instanceName}.`,
            retryable: false,
        });
    }
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
    return signal?.aborted === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (isAborted(signal)) throw abortError(signal);
}

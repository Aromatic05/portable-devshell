import type { Readable, Writable } from "node:stream";

import { createError, errorCodes, FramedStreamChannel, type Channel } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import type { WorkerRpcConnector } from "./WorkerRpcBridge.js";
import type { WorkerRpcProcess } from "./WorkerRpcProcess.js";

export class WorkerRpcProcessAdapter {
    readonly #process: WorkerRpcProcess;

    constructor(process: WorkerRpcProcess) {
        if (process.stdin === null || process.stdout === null || process.stderr === null) {
            throw createError({
                code: errorCodes.coreWorkerRpcSpawnFailed,
                message: "Worker RPC process must expose stdin, stdout, and stderr.",
                retryable: false
            });
        }

        this.#process = process;
    }

    static async spawn(
        transport: WorkerCommandTransport,
        options: WorkerRpcOptions,
        signal?: AbortSignal
    ): Promise<WorkerRpcProcessAdapter> {
        if (signal?.aborted === true) {
            throw abortError(signal);
        }
        const spawning = WorkerRpcProcessAdapter.#spawnProcess(transport, options, signal);
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
        transport: WorkerCommandTransport,
        options: WorkerRpcOptions,
        signal?: AbortSignal
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
            if (typeof error === "object" && error !== null && "code" in error && error.code === errorCodes.coreWorkerRpcSpawnFailed) {
                throw error;
            }

            throw createError({
                code: errorCodes.coreWorkerRpcSpawnFailed,
                cause: error,
                details: { instance: options.instanceName },
                message: `Worker RPC spawn failed for instance ${options.instanceName}.`,
                retryable: false
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

    get exit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
        return this.#process.exit;
    }

    kill(signal?: NodeJS.Signals | number): boolean {
        return this.#process.kill(signal);
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Worker RPC process connection was aborted.");
}

export class WorkerRpcProcessConnector implements WorkerRpcConnector {
    readonly #transport: WorkerCommandTransport;
    readonly #options: WorkerRpcOptions;

    constructor(transport: WorkerCommandTransport, options: WorkerRpcOptions) {
        this.#transport = transport;
        this.#options = options;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        const process = await WorkerRpcProcessAdapter.spawn(this.#transport, this.#options, signal);
        const channel = new FramedStreamChannel(process.stdout, process.stdin, {
            closeTransport: () => { process.kill("SIGTERM"); },
        });
        void process.exit.then(
            (result) => channel.close(new Error(`rpc process exited with code ${String(result.code)} signal ${String(result.signal)}`)),
            (error) => channel.close(error instanceof Error ? error : new Error(String(error))),
        );
        return channel;
    }
}

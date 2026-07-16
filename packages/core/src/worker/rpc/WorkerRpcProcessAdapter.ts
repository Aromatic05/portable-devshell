import type { Readable, Writable } from "node:stream";

import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
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

    static async spawn(transport: WorkerCommandTransport, options: WorkerRpcOptions): Promise<WorkerRpcProcessAdapter> {
        try {
            return new WorkerRpcProcessAdapter(await transport.spawnWorkerRpc(options));
        } catch (error) {
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

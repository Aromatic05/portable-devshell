import type { Readable, Writable } from "node:stream";

import type { WorkerCommandTransport } from "../provider/command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../provider/command/WorkerCommandOptions.js";
import type { WorkerRpcProcess } from "../provider/process/WorkerProcess.js";

export class WorkerRpcProcessAdapter {
    readonly #process: WorkerRpcProcess;

    constructor(process: WorkerRpcProcess) {
        if (process.stdin === null || process.stdout === null || process.stderr === null) {
            throw new Error("Worker RPC process must expose stdin, stdout, and stderr.");
        }

        this.#process = process;
    }

    static async spawn(transport: WorkerCommandTransport, options: WorkerRpcOptions): Promise<WorkerRpcProcessAdapter> {
        return new WorkerRpcProcessAdapter(await transport.spawnWorkerRpc(options));
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

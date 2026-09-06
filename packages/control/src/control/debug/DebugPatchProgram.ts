import { randomUUID } from "node:crypto";
import { Worker } from "node:worker_threads";

import type { JsonValue } from "@portable-devshell/shared";

interface DebugPatchProgramOptions {
    evaluationTimeoutMs: number;
    onFault?(error: Error): void;
}

interface PendingEvaluation {
    reject(error: Error): void;
    resolve(value: JsonValue): void;
    timer: NodeJS.Timeout;
}

type WorkerMessage =
    | { error: string; type: "initError" }
    | { type: "ready" }
    | { error: string; id: string; type: "resultError" }
    | { id: string; type: "result"; value: JsonValue };

const DEBUG_WORKER_SOURCE = String.raw`
const vm = require("node:vm");
const { parentPort, workerData } = require("node:worker_threads");

const errorText = (error) => error instanceof Error
    ? (error.stack || error.message)
    : String(error);

try {
    const context = vm.createContext(Object.create(null), {
        codeGeneration: { strings: true, wasm: false },
        name: "portable-devshell-debug"
    });
    const install = new vm.Script('"use strict";(' + workerData.source + ')', {
        filename: "devshell-debug-patch.js"
    });
    const hook = install.runInContext(context, { timeout: workerData.vmTimeoutMs });
    if (typeof hook !== "function") {
        throw new TypeError("Debug patch source must evaluate to a function.");
    }
    Object.defineProperty(context, "__debugHook", { value: hook, configurable: false });
    parentPort.postMessage({ type: "ready" });
    parentPort.on("message", async (message) => {
        if (message?.type !== "evaluate") return;
        try {
            Object.defineProperty(context, "__debugEvent", {
                configurable: true,
                value: message.event
            });
            const invoke = new vm.Script("__debugHook(__debugEvent)", {
                filename: "devshell-debug-invocation.js"
            });
            const value = await invoke.runInContext(context, { timeout: workerData.vmTimeoutMs });
            parentPort.postMessage({ id: message.id, type: "result", value });
        } catch (error) {
            parentPort.postMessage({ id: message.id, type: "resultError", error: errorText(error) });
        }
    });
} catch (error) {
    parentPort.postMessage({ type: "initError", error: errorText(error) });
}
`;

const DEBUG_WORKER_TERMINATE_WAIT_MS = 1_000;

export class DebugPatchProgram {
    readonly #evaluationTimeoutMs: number;
    readonly #onFault?: (error: Error) => void;
    readonly #pending = new Map<string, PendingEvaluation>();
    readonly #ready: Promise<void>;
    readonly #worker: Worker;
    #closing = false;
    #faulted = false;

    constructor(source: string, options: DebugPatchProgramOptions) {
        this.#evaluationTimeoutMs = options.evaluationTimeoutMs;
        this.#onFault = options.onFault;
        this.#worker = new Worker(DEBUG_WORKER_SOURCE, {
            eval: true,
            resourceLimits: {
                maxOldGenerationSizeMb: 16,
                maxYoungGenerationSizeMb: 4,
                stackSizeMb: 2,
            },
            workerData: {
                source,
                vmTimeoutMs: options.evaluationTimeoutMs,
            },
        });
        this.#ready = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(
                    `Debug patch initialization timed out after ${this.#evaluationTimeoutMs}ms.`,
                );
                reject(error);
                this.#fault(error);
            }, this.#evaluationTimeoutMs);
            const ready = (message: WorkerMessage) => {
                if (message.type === "ready") {
                    clearTimeout(timer);
                    this.#worker.off("message", ready);
                    resolve();
                    return;
                }
                if (message.type === "initError") {
                    clearTimeout(timer);
                    this.#worker.off("message", ready);
                    const error = new Error(message.error);
                    reject(error);
                    this.#fault(error);
                }
            };
            this.#worker.on("message", ready);
        });
        this.#worker.on("message", (message: WorkerMessage) => this.#accept(message));
        this.#worker.on("error", (error) => this.#fault(error));
        this.#worker.on("exit", (code) => {
            if (!this.#closing && !this.#faulted) {
                this.#fault(new Error(`Debug patch worker exited unexpectedly with code ${code}.`));
            }
        });
    }

    async start(): Promise<void> {
        await this.#ready;
    }

    async evaluate(event: JsonValue): Promise<JsonValue> {
        await this.#ready;
        if (this.#faulted || this.#closing) {
            throw new Error("Debug patch worker is not available.");
        }
        const id = randomUUID();
        return await new Promise<JsonValue>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (!this.#pending.delete(id)) return;
                const error = new Error(
                    `Debug patch evaluation timed out after ${this.#evaluationTimeoutMs}ms.`,
                );
                reject(error);
                this.#fault(error);
            }, this.#evaluationTimeoutMs);
            this.#pending.set(id, { reject, resolve, timer });
            try {
                this.#worker.postMessage({ event, id, type: "evaluate" });
            } catch (error) {
                clearTimeout(timer);
                this.#pending.delete(id);
                const failure = toError(error);
                reject(failure);
                this.#fault(failure);
            }
        });
    }

    async close(): Promise<void> {
        if (this.#closing) return;
        this.#closing = true;
        const error = new Error("Debug patch worker was unloaded.");
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        this.#worker.unref();
        const terminated = this.#worker.terminate().then(() => undefined, () => undefined);
        await Promise.race([terminated, delay(DEBUG_WORKER_TERMINATE_WAIT_MS)]);
    }

    #accept(message: WorkerMessage): void {
        if (message.type !== "result" && message.type !== "resultError") return;
        const pending = this.#pending.get(message.id);
        if (pending === undefined) return;
        this.#pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.type === "result") {
            pending.resolve(message.value);
            return;
        }
        pending.reject(new Error(message.error));
    }

    #fault(error: Error): void {
        if (this.#faulted || this.#closing) return;
        this.#faulted = true;
        for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.#pending.clear();
        void this.#worker.terminate().catch(() => undefined);
        this.#onFault?.(error);
    }
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref();
    });
}

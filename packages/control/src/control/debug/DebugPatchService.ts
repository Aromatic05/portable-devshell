import type { WorkerInstance } from "@portable-devshell/core";
import type {
    DebugPatchLoadRequest,
    DebugPatchSummary,
    DebugTargetSummary,
    JsonValue,
    ToolCallContext,
} from "@portable-devshell/shared";

import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import {
    DebugPatchManager,
    type DebugMethodAdapter,
} from "./DebugPatchManager.js";

export class DebugPatchService {
    readonly #instances: InstanceRegistry;
    readonly #manager: DebugPatchManager;
    readonly #registered = new Map<string, WorkerInstance>();
    readonly #unsubscribe: () => void;
    #syncTail: Promise<void> = Promise.resolve();

    constructor(
        instances: InstanceRegistry,
        manager: DebugPatchManager = new DebugPatchManager(),
    ) {
        this.#instances = instances;
        this.#manager = manager;
        this.#registerInitialTargets();
        this.#unsubscribe = instances.onChange(() => this.#scheduleSync());
    }

    listTargets(): DebugTargetSummary[] {
        return this.#manager.listTargets();
    }

    listPatches(): DebugPatchSummary[] {
        return this.#manager.listPatches();
    }

    async load(request: DebugPatchLoadRequest): Promise<DebugPatchSummary> {
        await this.#syncTail;
        return await this.#manager.load(request);
    }

    async unload(patchId: string): Promise<DebugPatchSummary> {
        return await this.#manager.unload(patchId);
    }

    release(patchId: string): DebugPatchSummary {
        return this.#manager.release(patchId);
    }

    async retireInstance(instance: string): Promise<void> {
        await this.#syncTail;
        await this.#manager.unregisterTarget(workerTarget(instance));
        this.#registered.delete(instance);
    }

    async dispose(): Promise<void> {
        this.#unsubscribe();
        await this.#syncTail;
        await this.#manager.dispose();
        this.#registered.clear();
    }

    #registerInitialTargets(): void {
        for (const descriptor of this.#instances.list()) {
            this.#manager.registerTarget(workerTarget(descriptor.name), descriptor.worker, {
                callTool: workerCallToolAdapter,
            });
            this.#registered.set(descriptor.name, descriptor.worker);
        }
    }

    #scheduleSync(): void {
        this.#syncTail = this.#syncTail
            .then(async () => await this.#syncTargets())
            .catch((error) => {
                console.warn(
                    "Failed to synchronize debug patch targets.",
                    error instanceof Error ? error : new Error(String(error)),
                );
            });
    }

    async #syncTargets(): Promise<void> {
        const next = new Map(
            this.#instances.list().map((entry) => [entry.name, entry.worker] as const),
        );
        for (const [name, worker] of [...this.#registered]) {
            if (next.get(name) === worker) continue;
            await this.#manager.unregisterTarget(workerTarget(name));
            this.#registered.delete(name);
        }
        for (const [name, worker] of next) {
            if (this.#registered.get(name) === worker) continue;
            this.#manager.registerTarget(workerTarget(name), worker, {
                callTool: workerCallToolAdapter,
            });
            this.#registered.set(name, worker);
        }
    }
}

const workerCallToolAdapter: DebugMethodAdapter = {
    project: (args) => {
        const context = args[2] as ToolCallContext | undefined;
        return {
            context: {
                ...(context?.ctxId === undefined ? {} : { ctxId: context.ctxId }),
                ...(context?.requestId === undefined ? {} : { requestId: context.requestId }),
                ...(context?.source === undefined ? {} : { source: context.source }),
                ...(context?.workspace === undefined ? {} : { workspace: context.workspace }),
            },
            input: cloneInput(args[1]),
            signalAborted: readAbortSignal(args[3])?.aborted ?? false,
            toolName: typeof args[0] === "string" ? args[0] : String(args[0]),
        };
    },
    signal: (args) => readAbortSignal(args[3]),
};

function workerTarget(instance: string): string {
    return `worker:${instance}`;
}

function cloneInput(value: unknown): JsonValue {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function readAbortSignal(value: unknown): AbortSignal | undefined {
    if (
        typeof value === "object" &&
        value !== null &&
        typeof (value as AbortSignal).addEventListener === "function" &&
        typeof (value as AbortSignal).removeEventListener === "function" &&
        typeof (value as AbortSignal).aborted === "boolean"
    ) {
        return value as AbortSignal;
    }
    return undefined;
}

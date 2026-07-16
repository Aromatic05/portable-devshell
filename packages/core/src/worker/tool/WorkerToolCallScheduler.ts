import { createError, errorCodes, type InstanceName, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import { readWorkerAbortReason } from "../WorkerAbortReason.js";

export interface WorkerToolSchedulerToolLimit {
    maxRunning?: number;
    queueDepth?: number;
}

export interface WorkerToolSchedulerLimits {
    maxRunning: number;
    queueDepth: number;
    queueTimeoutMs: number;
    maxRunningPerSession: number;
    queueDepthPerSession: number;
    byTool: Record<string, WorkerToolSchedulerToolLimit>;
}

export interface WorkerToolSchedulerRequest {
    callId: string;
    instanceName: InstanceName;
    ctxId?: string;
    source: ToolCallContext["source"];
    toolName: string;
}

export interface WorkerToolSchedulerReservation {
    markPendingApproval(): void;
    release(): void;
    run<T>(work: () => Promise<T>): Promise<T>;
}

type ToolSchedulerEntryState =
    | "reserved"
    | "pendingApproval"
    | "queued"
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "queueTimeout";

type SchedulerDetails = Record<string, JsonValue | undefined>;

interface ToolSchedulerEntry {
    queuedAt?: number;
    reject?: (error: unknown) => void;
    request: WorkerToolSchedulerRequest;
    resolve?: (value: unknown) => void;
    run?: () => Promise<unknown>;
    settled: boolean;
    state: ToolSchedulerEntryState;
    timeout?: NodeJS.Timeout;
    removeAbortListener?: () => void;
    cancellationReason?: unknown;
}

const terminalStates = new Set<ToolSchedulerEntryState>(["completed", "failed", "cancelled", "queueTimeout"]);

const urgentToolNames = new Set(["tmux_input", "tmux_inspect", "tmux_list"]);

function isUrgentTool(toolName: string): boolean {
    return urgentToolNames.has(toolName);
}

export const defaultWorkerToolSchedulerLimits: WorkerToolSchedulerLimits = {
    byTool: {
        bash_run: {
            maxRunning: 4,
            queueDepth: 16
        }
    },
    maxRunning: 4,
    maxRunningPerSession: 2,
    queueDepth: 16,
    queueDepthPerSession: 4,
    queueTimeoutMs: 30_000
};

export class WorkerToolSchedulerFullError extends Error {
    readonly code = errorCodes.coreToolSchedulerFull;
    readonly details: SchedulerDetails;

    constructor(details: SchedulerDetails) {
        super("Tool call queue is full.");
        this.details = details;
    }
}

export class WorkerToolQueueTimeoutError extends Error {
    readonly code = errorCodes.coreToolQueueTimeout;
    readonly details: SchedulerDetails;

    constructor(details: SchedulerDetails) {
        super("Tool call timed out while waiting in the execution queue.");
        this.details = details;
    }
}

export class WorkerToolCallScheduler {
    readonly #limits: WorkerToolSchedulerLimits;
    readonly #entries = new Map<string, ToolSchedulerEntry>();
    readonly #waiting: ToolSchedulerEntry[] = [];

    constructor(limits: WorkerToolSchedulerLimits = defaultWorkerToolSchedulerLimits) {
        this.#limits = limits;
    }

    reserve(request: WorkerToolSchedulerRequest, signal?: AbortSignal): WorkerToolSchedulerReservation {
        if (signal?.aborted === true) {
            throw this.#cancelledErrorForRequest(request, signal.reason);
        }
        if (this.#entries.has(request.callId)) {
            throw new Error(`Tool call ${request.callId} is already reserved.`);
        }
        this.#assertCapacity(request);

        const entry: ToolSchedulerEntry = {
            request,
            settled: false,
            state: "reserved"
        };
        this.#entries.set(request.callId, entry);
        if (signal !== undefined) {
            const onAbort = () => {
                entry.cancellationReason = signal.reason;
                this.#cancel(entry);
            };
            signal.addEventListener("abort", onAbort, { once: true });
            entry.removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        }

        return {
            markPendingApproval: () => {
                if (entry.state === "reserved") {
                    entry.state = "pendingApproval";
                }
            },
            release: () => {
                this.#cancel(entry);
            },
            run: async <T>(work: () => Promise<T>): Promise<T> => await this.#queue(entry, work)
        };
    }

    #assertCapacity(request: WorkerToolSchedulerRequest): void {
        const snapshot = this.#snapshot(request);
        const toolLimit = this.#toolLimit(request.toolName);
        const fullReasons: string[] = [];

        const urgentAllowance = isUrgentTool(request.toolName) ? 1 : 0;
        if (snapshot.accepted >= this.#limits.maxRunning + this.#limits.queueDepth + urgentAllowance) {
            fullReasons.push("instance");
        }
        if (snapshot.toolAccepted >= toolLimit.maxRunning + toolLimit.queueDepth) {
            fullReasons.push("tool");
        }
        if (
            request.ctxId !== undefined
            && snapshot.contextAccepted >= this.#limits.maxRunningPerSession + this.#limits.queueDepthPerSession + urgentAllowance
        ) {
            fullReasons.push("context");
        }
        if (fullReasons.length === 0) {
            return;
        }

        throw new WorkerToolSchedulerFullError({
            fullReasons,
            instance: request.instanceName,
            maxRunning: this.#limits.maxRunning,
            maxRunningPerSession: this.#limits.maxRunningPerSession,
            queueDepth: this.#limits.queueDepth,
            queueDepthPerSession: this.#limits.queueDepthPerSession,
            queued: snapshot.queued,
            running: snapshot.running,
            contextAccepted: snapshot.contextAccepted,
            ctxId: request.ctxId,
            contextQueued: snapshot.contextQueued,
            contextRunning: snapshot.contextRunning,
            toolAccepted: snapshot.toolAccepted,
            toolName: request.toolName,
            toolQueueDepth: toolLimit.queueDepth,
            toolQueued: snapshot.toolQueued,
            toolMaxRunning: toolLimit.maxRunning,
            toolRunning: snapshot.toolRunning
        });
    }

    async #queue<T>(entry: ToolSchedulerEntry, work: () => Promise<T>): Promise<T> {
        if (terminalStates.has(entry.state)) {
            throw this.#cancelledError(entry);
        }
        if (entry.state !== "reserved" && entry.state !== "pendingApproval") {
            throw new Error(`Tool call ${entry.request.callId} cannot be queued from state ${entry.state}.`);
        }

        return await new Promise<T>((resolve, reject) => {
            entry.queuedAt = Date.now();
            entry.resolve = (value) => resolve(value as T);
            entry.reject = reject;
            entry.run = work;
            entry.state = "queued";
            entry.timeout = setTimeout(() => {
                if (entry.state !== "queued") {
                    return;
                }
                this.#finish(entry, "queueTimeout", undefined, new WorkerToolQueueTimeoutError({
                    callId: entry.request.callId,
                    instance: entry.request.instanceName,
                    queueTimeoutMs: this.#limits.queueTimeoutMs,
                    queuedForMs: entry.queuedAt === undefined ? 0 : Date.now() - entry.queuedAt,
                    ctxId: entry.request.ctxId,
                    toolName: entry.request.toolName
                }));
                this.#drain();
            }, this.#limits.queueTimeoutMs);
            this.#waiting.push(entry);
            this.#drain();
        });
    }

    #drain(): void {
        for (;;) {
            let index = this.#waiting.findIndex(
                (entry) => entry.state === "queued" && isUrgentTool(entry.request.toolName) && this.#canRun(entry.request)
            );
            if (index === -1) {
                index = this.#waiting.findIndex((entry) => entry.state === "queued" && this.#canRun(entry.request));
            }
            if (index === -1) {
                return;
            }
            const [entry] = this.#waiting.splice(index, 1);
            this.#start(entry);
        }
    }

    #start(entry: ToolSchedulerEntry): void {
        if (entry.state !== "queued") {
            return;
        }
        this.#clearTimeout(entry);
        const work = entry.run;
        if (work === undefined) {
            this.#finish(entry, "failed", undefined, new Error("Queued tool call is missing its work function."));
            return;
        }

        entry.state = "running";
        void Promise.resolve()
            .then(work)
            .then((value) => {
                this.#finish(entry, "completed", value);
            })
            .catch((error: unknown) => {
                this.#finish(entry, "failed", undefined, error);
            })
            .finally(() => {
                this.#drain();
            });
    }

    #cancel(entry: ToolSchedulerEntry): void {
        if (terminalStates.has(entry.state) || entry.state === "running") {
            return;
        }
        this.#finish(entry, "cancelled", undefined, this.#cancelledError(entry));
        this.#drain();
    }

    #finish(entry: ToolSchedulerEntry, state: Extract<ToolSchedulerEntryState, "completed" | "failed" | "cancelled" | "queueTimeout">, value?: unknown, error?: unknown): void {
        if (entry.settled) {
            return;
        }
        entry.settled = true;
        entry.state = state;
        this.#clearTimeout(entry);
        this.#removeWaiting(entry);
        this.#entries.delete(entry.request.callId);

        if (state === "completed") {
            entry.resolve?.(value);
        } else {
            entry.reject?.(error);
        }

        entry.removeAbortListener?.();
        entry.removeAbortListener = undefined;
        entry.resolve = undefined;
        entry.reject = undefined;
        entry.run = undefined;
    }

    #cancelledError(entry: ToolSchedulerEntry) {
        return this.#cancelledErrorForRequest(entry.request, entry.cancellationReason);
    }

    #cancelledErrorForRequest(request: WorkerToolSchedulerRequest, reason: unknown) {
        return createError({
            code: errorCodes.coreToolCallCancelled,
            message: "Tool call was cancelled before it started.",
            retryable: true,
            details: {
                callId: request.callId,
                instance: request.instanceName,
                reason: readWorkerAbortReason(reason),
                toolName: request.toolName
            }
        });
    }

    #clearTimeout(entry: ToolSchedulerEntry): void {
        if (entry.timeout !== undefined) {
            clearTimeout(entry.timeout);
            entry.timeout = undefined;
        }
    }

    #removeWaiting(entry: ToolSchedulerEntry): void {
        const index = this.#waiting.indexOf(entry);
        if (index !== -1) {
            this.#waiting.splice(index, 1);
        }
    }

    #canRun(request: WorkerToolSchedulerRequest): boolean {
        const snapshot = this.#snapshot(request);
        const toolLimit = this.#toolLimit(request.toolName);
        const urgentAllowance = isUrgentTool(request.toolName) ? 1 : 0;
        if (snapshot.running >= this.#limits.maxRunning + urgentAllowance) {
            return false;
        }
        if (snapshot.toolRunning >= toolLimit.maxRunning) {
            return false;
        }
        if (
            request.ctxId !== undefined
            && snapshot.contextRunning >= this.#limits.maxRunningPerSession + urgentAllowance
        ) {
            return false;
        }
        return true;
    }

    #snapshot(request: WorkerToolSchedulerRequest): {
        accepted: number;
        queued: number;
        running: number;
        contextAccepted: number;
        contextQueued: number;
        contextRunning: number;
        toolAccepted: number;
        toolQueued: number;
        toolRunning: number;
    } {
        const entries = [...this.#entries.values()].filter((entry) => !terminalStates.has(entry.state));
        const queuedEntries = entries.filter((entry) => entry.state === "reserved" || entry.state === "pendingApproval" || entry.state === "queued");
        const runningEntries = entries.filter((entry) => entry.state === "running");
        const toolEntries = entries.filter((entry) => entry.request.toolName === request.toolName);
        const toolQueuedEntries = queuedEntries.filter((entry) => entry.request.toolName === request.toolName);
        const toolRunningEntries = runningEntries.filter((entry) => entry.request.toolName === request.toolName);
        const contextEntries = request.ctxId === undefined ? [] : entries.filter((entry) => entry.request.ctxId === request.ctxId);
        const contextQueuedEntries = request.ctxId === undefined ? [] : queuedEntries.filter((entry) => entry.request.ctxId === request.ctxId);
        const contextRunningEntries = request.ctxId === undefined ? [] : runningEntries.filter((entry) => entry.request.ctxId === request.ctxId);

        return {
            accepted: entries.length,
            queued: queuedEntries.length,
            running: runningEntries.length,
            contextAccepted: contextEntries.length,
            contextQueued: contextQueuedEntries.length,
            contextRunning: contextRunningEntries.length,
            toolAccepted: toolEntries.length,
            toolQueued: toolQueuedEntries.length,
            toolRunning: toolRunningEntries.length
        };
    }

    #toolLimit(toolName: string): Required<WorkerToolSchedulerToolLimit> {
        const override = this.#limits.byTool[toolName] ?? {};
        return {
            maxRunning: override.maxRunning ?? this.#limits.maxRunning,
            queueDepth: override.queueDepth ?? this.#limits.queueDepth
        };
    }
}

export function resolveWorkerToolSchedulerLimits(input?: Partial<WorkerToolSchedulerLimits>): WorkerToolSchedulerLimits {
    return {
        byTool: {
            ...defaultWorkerToolSchedulerLimits.byTool,
            ...(input?.byTool ?? {})
        },
        maxRunning: input?.maxRunning ?? defaultWorkerToolSchedulerLimits.maxRunning,
        maxRunningPerSession: input?.maxRunningPerSession ?? defaultWorkerToolSchedulerLimits.maxRunningPerSession,
        queueDepth: input?.queueDepth ?? defaultWorkerToolSchedulerLimits.queueDepth,
        queueDepthPerSession: input?.queueDepthPerSession ?? defaultWorkerToolSchedulerLimits.queueDepthPerSession,
        queueTimeoutMs: input?.queueTimeoutMs ?? defaultWorkerToolSchedulerLimits.queueTimeoutMs
    };
}

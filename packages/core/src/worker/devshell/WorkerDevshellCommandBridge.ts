import type { JsonValue } from "@portable-devshell/shared";

import type { WorkerProtocolClient } from "../protocol/WorkerProtocolClient.js";
import type { WorkerRpcBridge } from "../rpc/WorkerRpcBridge.js";
import type { WorkerRpcNotificationEnvelope } from "../rpc/WorkerRpcEnvelope.js";

export interface WorkerDevshellCommandOpen {
    argv: readonly string[];
    ctxId: string;
    cwd: string;
    parentCallId: string;
    sessionId: string;
    taskId?: string;
    workspace: string;
}

export interface WorkerDevshellCommandClose {
    sessionId: string;
}

export type WorkerDevshellCommandStream = "stderr" | "stdout";

export interface WorkerDevshellCommandOutput {
    data: string;
    sessionId: string;
    stream: WorkerDevshellCommandStream;
}

export interface WorkerDevshellCommandCompletion {
    error?: string;
    exitCode: number;
    sessionId: string;
}

export class WorkerDevshellCommandBridge {
    readonly #closeListeners = new Set<(request: WorkerDevshellCommandClose) => void>();
    readonly #openListeners = new Set<(request: WorkerDevshellCommandOpen) => void>();
    readonly #protocol: WorkerProtocolClient;
    readonly #unsubscribe: () => void;

    constructor(rpc: WorkerRpcBridge, protocol: WorkerProtocolClient) {
        this.#protocol = protocol;
        this.#unsubscribe = rpc.onNotification((notification) => this.#onNotification(notification));
    }

    close(): void {
        this.#unsubscribe();
        this.#closeListeners.clear();
        this.#openListeners.clear();
    }

    onOpen(listener: (request: WorkerDevshellCommandOpen) => void): () => void {
        this.#openListeners.add(listener);
        return () => this.#openListeners.delete(listener);
    }

    onClose(listener: (request: WorkerDevshellCommandClose) => void): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    async output(output: WorkerDevshellCommandOutput): Promise<void> {
        await this.#protocol.writeDevshellCommandOutput(output);
    }

    async complete(completion: WorkerDevshellCommandCompletion): Promise<void> {
        await this.#protocol.completeDevshellCommand(completion);
    }

    #onNotification(notification: WorkerRpcNotificationEnvelope): void {
        if (notification.method === "devshell.command.open") {
            const request = readOpen(notification.params);
            if (request === undefined) return;
            this.#notify(this.#openListeners, request);
            return;
        }
        if (notification.method === "devshell.command.close") {
            const request = readClose(notification.params);
            if (request === undefined) return;
            this.#notify(this.#closeListeners, request);
        }
    }

    #notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                console.warn(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }
}

function readOpen(value: JsonValue): WorkerDevshellCommandOpen | undefined {
    if (!isRecord(value)) return undefined;
    if (
        typeof value.sessionId !== "string" || value.sessionId.length === 0 ||
        typeof value.ctxId !== "string" || value.ctxId.length === 0 ||
        typeof value.parentCallId !== "string" || value.parentCallId.length === 0 ||
        typeof value.workspace !== "string" || value.workspace.length === 0 ||
        typeof value.cwd !== "string" || value.cwd.length === 0 ||
        !Array.isArray(value.argv) || value.argv.length === 0 ||
        !value.argv.every((candidate) => typeof candidate === "string") ||
        (value.taskId !== null && value.taskId !== undefined && typeof value.taskId !== "string")
    ) {
        return undefined;
    }
    return Object.freeze({
        argv: [...value.argv] as string[],
        ctxId: value.ctxId,
        cwd: value.cwd,
        parentCallId: value.parentCallId,
        sessionId: value.sessionId,
        ...(typeof value.taskId === "string" && value.taskId.length > 0 ? { taskId: value.taskId } : {}),
        workspace: value.workspace
    });
}

function readClose(value: JsonValue): WorkerDevshellCommandClose | undefined {
    if (!isRecord(value) || typeof value.sessionId !== "string" || value.sessionId.length === 0) {
        return undefined;
    }
    return Object.freeze({ sessionId: value.sessionId });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

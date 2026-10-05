import type { WorkerCommandSessionOpen, WorkerCommandSessionClose, WorkerCommandSessionOutput, WorkerCommandSessionCompletion } from "../../Api.js";
import { Endpoint, Event, type JsonValue } from "@portable-devshell/shared";

import type { WorkerProtocolClient } from "../../transport/packet/Client.js";











export class WorkerCommandSessionBridge {
    readonly #closeListeners = new Set<
        (request: WorkerCommandSessionClose) => void
    >();
    readonly #openListeners = new Set<
        (request: WorkerCommandSessionOpen) => void
    >();
    readonly #protocol: WorkerProtocolClient;
    readonly #unsubscribe: () => void;

    constructor(
        endpoint: Endpoint,
        workerHost: string,
        protocol: WorkerProtocolClient,
    ) {
        this.#protocol = protocol;
        const events = new Event(endpoint.bind("core"));
        this.#unsubscribe = events.onEvent((name, message, peer) => {
            if (peer.host === workerHost)
                this.#onEvent(name, (message ?? null) as JsonValue);
        });
    }

    close(): void {
        this.#unsubscribe();
        this.#closeListeners.clear();
        this.#openListeners.clear();
    }

    onOpen(listener: (request: WorkerCommandSessionOpen) => void): () => void {
        this.#openListeners.add(listener);
        return () => this.#openListeners.delete(listener);
    }

    onClose(
        listener: (request: WorkerCommandSessionClose) => void,
    ): () => void {
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    async output(output: WorkerCommandSessionOutput): Promise<void> {
        await this.#protocol.writeCommandSessionOutput(output);
    }

    async complete(completion: WorkerCommandSessionCompletion): Promise<void> {
        await this.#protocol.completeCommandSession(completion);
    }

    #onEvent(name: string, message: JsonValue): void {
        if (name === "command.open") {
            const request = readOpen(message);
            if (request === undefined) return;
            this.#notify(this.#openListeners, request);
            return;
        }
        if (name === "command.close") {
            const request = readClose(message);
            if (request === undefined) return;
            this.#notify(this.#closeListeners, request);
        }
    }

    #notify<T>(listeners: ReadonlySet<(value: T) => void>, value: T): void {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            } catch (error) {
                console.warn(
                    error instanceof Error ? error : new Error(String(error)),
                );
            }
        }
    }
}

function readOpen(value: JsonValue): WorkerCommandSessionOpen | undefined {
    if (!isRecord(value)) return undefined;
    if (
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0 ||
        typeof value.ctxId !== "string" ||
        value.ctxId.length === 0 ||
        typeof value.parentCallId !== "string" ||
        value.parentCallId.length === 0 ||
        typeof value.workspace !== "string" ||
        value.workspace.length === 0 ||
        typeof value.cwd !== "string" ||
        value.cwd.length === 0 ||
        !Array.isArray(value.argv) ||
        value.argv.length === 0 ||
        !value.argv.every((candidate) => typeof candidate === "string") ||
        (value.taskId !== null &&
            value.taskId !== undefined &&
            typeof value.taskId !== "string")
    ) {
        return undefined;
    }
    return Object.freeze({
        argv: [...value.argv] as string[],
        ctxId: value.ctxId,
        cwd: value.cwd,
        parentCallId: value.parentCallId,
        sessionId: value.sessionId,
        ...(typeof value.taskId === "string" && value.taskId.length > 0
            ? { taskId: value.taskId }
            : {}),
        workspace: value.workspace,
    });
}

function readClose(value: JsonValue): WorkerCommandSessionClose | undefined {
    if (
        !isRecord(value) ||
        typeof value.sessionId !== "string" ||
        value.sessionId.length === 0
    ) {
        return undefined;
    }
    return Object.freeze({ sessionId: value.sessionId });
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

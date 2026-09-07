import { randomUUID } from "node:crypto";

import type { DevshellPiToolDefinition, DevshellPiToolSession } from "@portable-devshell/pi-extension";
import type { JsonValue } from "@portable-devshell/shared";

import type { AgentWorkerTarget } from "../../target/AgentWorkerTarget.js";
import type {
    PiChildMessage,
    PiParentMessage,
    PiParentToolResultMessage
} from "./PiProcessProtocol.js";

interface PendingToolRequest {
    reject(error: Error): void;
    resolve(value: JsonValue): void;
}

export class PiChildToolSession implements DevshellPiToolSession {
    readonly target: AgentWorkerTarget;
    readonly tools: readonly DevshellPiToolDefinition[];
    readonly #agentId: string;
    readonly #pending = new Map<string, PendingToolRequest>();
    readonly #send: (message: PiChildMessage) => Promise<void> | void;
    #closed = false;

    constructor(options: {
        agentId: string;
        send(message: PiChildMessage): Promise<void> | void;
        target: AgentWorkerTarget;
        tools: readonly DevshellPiToolDefinition[];
    }) {
        this.#agentId = options.agentId;
        this.#send = options.send;
        this.target = { ...options.target };
        this.tools = options.tools.map((tool) => ({ ...tool }));
    }

    async callTool(
        toolName: string,
        input: JsonValue,
        operationId: string,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        if (this.#closed) throw new Error(`Pi Agent ${this.#agentId} tool session is closed.`);
        signal?.throwIfAborted();
        const callId = randomUUID();
        const response = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(callId, { resolve, reject });
        });
        const abort = () => {
            const pending = this.#pending.get(callId);
            if (pending === undefined) return;
            this.#pending.delete(callId);
            void Promise.resolve(this.#send({ agentId: this.#agentId, callId, type: "tool.cancel" })).catch(() => undefined);
            pending.reject(abortError(signal));
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
            await this.#send({
                agentId: this.#agentId,
                callId,
                input,
                operationId,
                toolName,
                type: "tool.call"
            });
            return await response;
        } catch (error) {
            this.#pending.delete(callId);
            throw error;
        } finally {
            signal?.removeEventListener("abort", abort);
        }
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const active = [...this.#pending.entries()];
        this.#pending.clear();
        for (const [callId, pending] of active) {
            void Promise.resolve(this.#send({ agentId: this.#agentId, callId, type: "tool.cancel" })).catch(() => undefined);
            pending.reject(new Error(`Pi Agent ${this.#agentId} tool session closed.`));
        }
        const callId = randomUUID();
        const response = new Promise<JsonValue>((resolve, reject) => {
            this.#pending.set(callId, { resolve, reject });
        });
        try {
            await this.#send({ agentId: this.#agentId, callId, type: "tool.close" });
            await response;
        } finally {
            this.#pending.delete(callId);
        }
    }

    accept(message: PiParentMessage): boolean {
        if (message.type !== "tool.result" || message.agentId !== this.#agentId) return false;
        this.#acceptResult(message);
        return true;
    }

    disconnect(error: Error): void {
        this.#closed = true;
        for (const pending of this.#pending.values()) pending.reject(error);
        this.#pending.clear();
    }

    #acceptResult(message: PiParentToolResultMessage): void {
        const pending = this.#pending.get(message.callId);
        if (pending === undefined) return;
        this.#pending.delete(message.callId);
        if (!message.ok) {
            pending.reject(new Error(message.error ?? "Pi tool request failed."));
            return;
        }
        pending.resolve(message.result ?? null);
    }
}

function abortError(signal: AbortSignal | undefined): Error {
    return signal?.reason instanceof Error ? signal.reason : new Error("Pi tool call was aborted.");
}

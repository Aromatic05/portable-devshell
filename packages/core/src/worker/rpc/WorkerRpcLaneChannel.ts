import type { Channel, JsonValue } from "@portable-devshell/shared";

import { decodeWorkerRpcMessage } from "./WorkerRpcEnvelope.js";

export type WorkerRpcLane = "control" | "bulk";

interface PendingFrame {
    frame: Uint8Array;
    lane: WorkerRpcLane;
}

export class WorkerRpcLaneChannel implements Channel {
    readonly #closeListeners = new Set<(error?: Error) => void>();
    readonly #frameListeners = new Set<(frame: Uint8Array) => void>();
    readonly #pending = new Map<string, PendingFrame>();
    #bulk?: Channel;
    #control?: Channel;
    #closed = false;

    get closed(): boolean { return this.#closed; }
    get connected(): boolean { return this.#control !== undefined && !this.#control.closed; }

    attach(channel: Channel, lane: WorkerRpcLane): void {
        if (this.#closed) {
            channel.close();
            return;
        }
        const previous = lane === "bulk" ? this.#bulk : this.#control;
        if (lane === "bulk") this.#bulk = channel;
        else this.#control = channel;
        if (previous !== undefined && previous !== channel) previous.close();

        channel.onFrame((frame) => {
            if (!this.#isCurrent(channel, lane) || this.#closed) return;
            const message = asRecord(decodeWorkerRpcMessage(frame));
            if (message?.type === "response" && typeof message.id === "string") {
                this.#pending.delete(message.id);
            }
            for (const listener of [...this.#frameListeners]) listener(frame);
        });
        channel.onClose((error) => {
            if (!this.#isCurrent(channel, lane) || this.#closed) return;
            if (lane === "bulk") {
                this.#bulk = undefined;
                void this.#replayBulkOnControl().catch((cause) => this.close(asError(cause)));
                return;
            }
            this.#control = undefined;
            this.close(error);
        });
    }

    detach(channel?: Channel): void {
        if (channel === undefined || channel === this.#control) {
            const control = this.#control;
            this.#control = undefined;
            if (channel === undefined) {
                const bulk = this.#bulk;
                this.#bulk = undefined;
                bulk?.close();
            }
            control?.close();
            this.close();
            return;
        }
        if (channel === this.#bulk) {
            this.#bulk = undefined;
            channel.close();
            void this.#replayBulkOnControl().catch((cause) => this.close(asError(cause)));
        }
    }

    async send(frame: Uint8Array): Promise<void> {
        if (this.#closed) throw new Error("Reverse RPC lane channel is closed.");
        const request = asRecord(decodeWorkerRpcMessage(frame));
        const requestId = request?.type === "request" && typeof request.id === "string"
            ? request.id
            : undefined;
        const lane = this.#laneFor(request);
        const channel = lane === "bulk" ? this.#bulk ?? this.#control : this.#control;
        if (channel === undefined) throw new Error("Reverse RPC control lane is offline.");
        if (requestId !== undefined) this.#pending.set(requestId, { frame: Uint8Array.from(frame), lane });
        try {
            await channel.send(frame);
        } catch (error) {
            if (lane !== "bulk" || channel === this.#control || this.#control === undefined) throw error;
            if (requestId !== undefined) this.#pending.set(requestId, { frame: Uint8Array.from(frame), lane: "control" });
            await this.#control.send(frame);
        }
    }

    onFrame(listener: (frame: Uint8Array) => void): () => void {
        if (this.#closed) return () => undefined;
        this.#frameListeners.add(listener);
        return () => this.#frameListeners.delete(listener);
    }

    onClose(listener: (error?: Error) => void): () => void {
        if (this.#closed) {
            queueMicrotask(() => listener());
            return () => undefined;
        }
        this.#closeListeners.add(listener);
        return () => this.#closeListeners.delete(listener);
    }

    close(error?: Error): void {
        if (this.#closed) return;
        this.#closed = true;
        const control = this.#control;
        const bulk = this.#bulk;
        this.#control = undefined;
        this.#bulk = undefined;
        control?.close(error);
        if (bulk !== control) bulk?.close(error);
        this.#pending.clear();
        this.#frameListeners.clear();
        const listeners = [...this.#closeListeners];
        this.#closeListeners.clear();
        for (const listener of listeners) listener(error);
    }

    #isCurrent(channel: Channel, lane: WorkerRpcLane): boolean {
        return lane === "bulk" ? this.#bulk === channel : this.#control === channel;
    }

    #laneFor(request: Record<string, JsonValue> | undefined): WorkerRpcLane {
        if (request?.type !== "request") return "control";
        const method = typeof request.method === "string" ? request.method : "";
        if (method === "tool.call.cancel") {
            const params = asRecord(request.params);
            const target = typeof params?.rpcRequestId === "string" ? this.#pending.get(params.rpcRequestId) : undefined;
            return target?.lane ?? "control";
        }
        return isBulkMethod(method) ? "bulk" : "control";
    }

    async #replayBulkOnControl(): Promise<void> {
        const control = this.#control;
        if (control === undefined) return;
        for (const [requestId, pending] of this.#pending) {
            if (pending.lane !== "bulk") continue;
            this.#pending.set(requestId, { ...pending, lane: "control" });
            await control.send(pending.frame);
        }
    }
}

export function isBulkWorkerRpcMethod(method: string): boolean {
    return isBulkMethod(method);
}

function isBulkMethod(method: string): boolean {
    return method.startsWith("artifact.payload.") || method.startsWith("artifact.receive.");
}

function asRecord(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, JsonValue>
        : undefined;
}

function asError(value: unknown): Error {
    return value instanceof Error ? value : new Error(String(value));
}

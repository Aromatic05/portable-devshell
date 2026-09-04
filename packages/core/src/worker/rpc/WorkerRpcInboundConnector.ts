import { createError, errorCodes, type Channel } from "@portable-devshell/shared";

import type { WorkerRpcConnector } from "./WorkerRpcBridge.js";
import { WorkerRpcLaneChannel, type WorkerRpcLane } from "./WorkerRpcLaneChannel.js";

export class WorkerRpcInboundConnector implements WorkerRpcConnector {
    #channel?: WorkerRpcLaneChannel;
    #physical = new Map<Channel, WorkerRpcLane>();

    attach(channel: Channel, lane: WorkerRpcLane = "control"): void {
        if (lane === "control" || this.#channel === undefined || this.#channel.closed) {
            if (lane === "bulk" && (this.#channel === undefined || this.#channel.closed)) {
                channel.close();
                return;
            }
            if (lane === "control") {
                this.#channel?.close();
                this.#physical.clear();
                this.#channel = new WorkerRpcLaneChannel();
            }
        }
        this.#physical.set(channel, lane);
        this.#channel!.attach(channel, lane);
        channel.onClose(() => this.#physical.delete(channel));
    }

    detach(channel?: Channel): void {
        if (channel === undefined) {
            this.#channel?.detach();
            this.#channel = undefined;
            this.#physical.clear();
            return;
        }
        const lane = this.#physical.get(channel);
        if (lane === undefined) return;
        this.#physical.delete(channel);
        this.#channel?.detach(channel);
        if (lane === "control") this.#channel = undefined;
    }

    get connected(): boolean {
        return this.#channel?.connected === true;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        if (signal?.aborted === true) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error("Reverse worker connection was aborted.");
        }
        if (this.#channel?.connected === true) return this.#channel;

        throw createError({
            code: errorCodes.reverseTransportUnavailable,
            message: "Reverse worker is offline.",
            retryable: true
        });
    }
}

import { createError, errorCodes, type Channel } from "@portable-devshell/shared";

import type { WorkerRpcConnector } from "./WorkerRpcBridge.js";

export class WorkerRpcInboundConnector implements WorkerRpcConnector {
    #channel?: Channel;

    attach(channel: Channel): void {
        this.#channel = channel;
    }

    detach(channel?: Channel): void {
        if (channel === undefined || this.#channel === channel) {
            this.#channel = undefined;
        }
    }

    get connected(): boolean {
        return this.#channel !== undefined;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        if (signal?.aborted === true) {
            throw signal.reason instanceof Error
                ? signal.reason
                : new Error("Reverse worker connection was aborted.");
        }
        if (this.#channel !== undefined) {
            return this.#channel;
        }

        throw createError({
            code: errorCodes.reverseTransportUnavailable,
            message: "Reverse worker is offline.",
            retryable: true
        });
    }
}

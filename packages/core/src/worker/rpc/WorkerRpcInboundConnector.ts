import { createError, errorCodes } from "@portable-devshell/shared";

import type { WorkerRpcChannel, WorkerRpcConnector } from "./WorkerRpcChannel.js";

export class WorkerRpcInboundConnector implements WorkerRpcConnector {
    #channel?: WorkerRpcChannel;

    attach(channel: WorkerRpcChannel): void {
        this.#channel = channel;
    }

    detach(channel?: WorkerRpcChannel): void {
        if (channel === undefined || this.#channel === channel) {
            this.#channel = undefined;
        }
    }

    get connected(): boolean {
        return this.#channel !== undefined;
    }

    async connect(): Promise<WorkerRpcChannel> {
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

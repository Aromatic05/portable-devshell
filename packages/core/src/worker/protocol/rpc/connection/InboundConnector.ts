import {
    createError,
    errorCodes,
    type Channel,
} from "@portable-devshell/shared";

import { openWorkerService } from "../../../transport/Transport.js";
import type { WorkerRpcConnector } from "./Bridge.js";

interface ReverseFrameConnection {
    channel?: Channel;
    physical: Channel;
    opening: Promise<Channel>;
}

export class WorkerRpcInboundConnector implements WorkerRpcConnector {
    #current?: ReverseFrameConnection;

    attach(channel: Channel): void {
        this.#closeCurrent();
        const current = {
            physical: channel,
        } as ReverseFrameConnection;
        current.opening = openWorkerService(channel, "worker.rpc").then((routed) => {
            if (this.#current !== current) {
                routed.close();
                throw createError({
                    code: errorCodes.reverseConnectionSuperseded,
                    message: "Reverse worker connection was superseded.",
                    retryable: true,
                });
            }
            current.channel = routed;
            routed.onClose(() => {
                if (this.#current === current) this.#current = undefined;
            });
            return routed;
        });
        void current.opening.catch(() => undefined);
        this.#current = current;
    }

    detach(channel?: Channel): void {
        const current = this.#current;
        if (
            current === undefined ||
            (channel !== undefined && channel !== current.physical)
        ) {
            return;
        }
        this.#current = undefined;
        if (current.channel !== undefined) current.channel.close();
        else current.physical.close();
    }

    get connected(): boolean {
        return this.#current?.channel?.closed === false;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        throwIfAborted(signal);
        const current = this.#current;
        if (current === undefined) throw offlineError();
        const channel = current.channel ?? (await current.opening);
        if (isAborted(signal)) {
            channel.close();
            throw abortError(signal);
        }
        if (this.#current !== current || channel.closed) throw offlineError();
        return channel;
    }

    #closeCurrent(): void {
        const current = this.#current;
        if (current === undefined) return;
        this.#current = undefined;
        if (current.channel !== undefined) current.channel.close();
        else current.physical.close();
    }
}

function abortError(signal: AbortSignal): Error {
    return signal.reason instanceof Error
        ? signal.reason
        : new Error("Reverse worker connection was aborted.");
}

function isAborted(signal: AbortSignal | undefined): signal is AbortSignal {
    return signal?.aborted === true;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (isAborted(signal)) throw abortError(signal);
}

function offlineError(): Error {
    return createError({
        code: errorCodes.reverseTransportUnavailable,
        message: "Reverse worker is offline.",
        retryable: true,
    });
}

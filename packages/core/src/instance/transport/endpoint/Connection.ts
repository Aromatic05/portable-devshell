import type { Channel, ReverseTransport } from "@portable-devshell/shared";

export interface ReverseAttachment {
    connectedAt?: string;
    credentialReplacement?: boolean;
    generation: number;
    transport: ReverseTransport;
}

export class TransportConnection {
    readonly #connect?: (signal?: AbortSignal) => Promise<Channel>;
    readonly #attachListeners = new Set<(input: ReverseAttachment) => Promise<unknown>>();
    #attached?: Channel;

    constructor(connect?: (signal?: AbortSignal) => Promise<Channel>) {
        this.#connect = connect;
    }

    onAttach(listener: (input: ReverseAttachment) => Promise<unknown>): () => void {
        this.#attachListeners.add(listener);
        return () => this.#attachListeners.delete(listener);
    }

    async attach(channel: Channel, input?: ReverseAttachment): Promise<void> {
        const previous = this.#attached;
        this.#attached = channel;
        try {
            if (input !== undefined)
                for (const listener of this.#attachListeners) await listener(input);
        } catch (error) {
            channel.close(error instanceof Error ? error : new Error(String(error)));
            if (this.#attached === channel) this.#attached = previous;
            throw error;
        }
        if (previous !== channel) previous?.close();
    }

    takeAttached(): Channel | undefined {
        const attached = this.#attached;
        this.#attached = undefined;
        return attached;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        signal?.throwIfAborted();
        if (this.#connect === undefined)
            throw new Error("Worker transport connection is not attached.");
        const channel = await this.#connect(signal);
        if (signal?.aborted) {
            channel.close(signal.reason instanceof Error ? signal.reason : new Error("Worker transport connection aborted."));
            signal.throwIfAborted();
        }
        return channel;
    }

    close(error?: Error): void {
        this.#attached?.close(error);
        this.#attached = undefined;
    }
}

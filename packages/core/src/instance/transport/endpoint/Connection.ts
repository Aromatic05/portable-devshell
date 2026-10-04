import type { Channel } from "@portable-devshell/shared";

export class TransportConnection {
    readonly #connect?: () => Promise<Channel>;
    #attached?: Channel;

    constructor(connect?: () => Promise<Channel>) {
        this.#connect = connect;
    }

    attach(channel: Channel): void {
        this.#attached?.close();
        this.#attached = channel;
    }

    async connect(signal?: AbortSignal): Promise<Channel> {
        signal?.throwIfAborted();
        const attached = this.#attached;
        if (attached !== undefined) {
            this.#attached = undefined;
            return attached;
        }
        if (this.#connect === undefined)
            throw new Error("Worker transport connection is not attached.");
        const channel = await this.#connect();
        signal?.throwIfAborted();
        return channel;
    }

    close(error?: Error): void {
        this.#attached?.close(error);
        this.#attached = undefined;
    }
}

import type {
    ChannelProvider,
    FrameChannel,
} from "@portable-devshell/shared/browser";

export class ObservableChannelProvider implements ChannelProvider {
    #listeners = new Set<(error: Error) => void>();
    #connectionId = 0;

    constructor(private readonly delegate: ChannelProvider) {}

    onClose(listener: (error: Error) => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async connect(signal?: AbortSignal): Promise<FrameChannel> {
        const connectionId = ++this.#connectionId;
        const channel = await this.delegate.connect(signal);
        channel.onClose((error) => {
            if (connectionId !== this.#connectionId) return;
            const reason = error ?? new Error("WebSocket connection closed.");
            for (const listener of this.#listeners) listener(reason);
        });
        return channel;
    }
}

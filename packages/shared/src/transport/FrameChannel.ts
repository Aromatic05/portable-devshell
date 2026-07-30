export interface FrameChannel {
    readonly closed: boolean;
    send(frame: Uint8Array): Promise<void>;
    onFrame(listener: (frame: Uint8Array) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;
    close(error?: Error): void;
}

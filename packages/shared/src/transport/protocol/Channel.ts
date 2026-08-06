import type { Frame } from "./Frame.js";

export interface Channel {
    readonly closed: boolean;
    send(frame: Frame): Promise<void>;
    onFrame(listener: (frame: Frame) => void): () => void;
    onClose(listener: (error?: Error) => void): () => void;
    close(error?: Error): void;
}

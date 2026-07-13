import type { JsonValue } from "@portable-devshell/shared";

export interface WorkerRpcChannel {
    close(): void;
    onDisconnect(listener: (error: unknown) => void): () => void;
    onMessage(listener: (message: JsonValue) => void): () => void;
    send(message: JsonValue): Promise<void>;
}

export interface WorkerRpcConnector {
    attach?(channel: WorkerRpcChannel): void;
    connect(): Promise<WorkerRpcChannel>;
    detach?(channel?: WorkerRpcChannel): void;
}
import type { JsonValue } from "@portable-devshell/shared";

export interface WorkerRpcChannel {
    close(): void;
    onDisconnect(listener: (error: unknown) => void): () => void;
    onMessage(listener: (message: JsonValue) => void): () => void;
    send(message: JsonValue): Promise<void>;
}

export abstract class WorkerRpcChannelBase implements WorkerRpcChannel {
    readonly #messageListeners = new Set<(message: JsonValue) => void>();
    readonly #disconnectListeners = new Set<(error: unknown) => void>();
    #disconnected = false;

    protected get disconnected(): boolean {
        return this.#disconnected;
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => this.#disconnectListeners.delete(listener);
    }

    protected emitMessage(message: JsonValue): void {
        for (const listener of this.#messageListeners) {
            listener(message);
        }
    }

    protected notifyDisconnect(error: unknown, cleanup?: () => void): void {
        if (this.#disconnected) {
            return;
        }
        this.#disconnected = true;
        cleanup?.();
        for (const listener of this.#disconnectListeners) {
            listener(error);
        }
    }

    abstract close(): void;
    abstract send(message: JsonValue): Promise<void>;
}

export interface WorkerRpcConnector {
    attach?(channel: WorkerRpcChannel): void;
    connect(): Promise<WorkerRpcChannel>;
    detach?(channel?: WorkerRpcChannel): void;
}

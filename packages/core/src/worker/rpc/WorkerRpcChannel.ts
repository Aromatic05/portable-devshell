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
    #disconnectError?: unknown;

    protected get disconnected(): boolean {
        return this.#disconnected;
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        if (this.#disconnected) {
            return () => undefined;
        }
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        if (this.#disconnected) {
            queueMicrotask(() => this.#notifyListener(listener, this.#disconnectError));
            return () => undefined;
        }
        this.#disconnectListeners.add(listener);
        return () => this.#disconnectListeners.delete(listener);
    }

    protected emitMessage(message: JsonValue): void {
        if (this.#disconnected) {
            return;
        }
        for (const listener of [...this.#messageListeners]) {
            this.#notifyListener(listener, message);
        }
    }

    protected notifyDisconnect(error: unknown, cleanup?: () => void): void {
        if (this.#disconnected) {
            return;
        }
        this.#disconnected = true;
        this.#disconnectError = error;
        try {
            cleanup?.();
        } catch (cleanupError) {
            this.#warn(cleanupError);
        }
        this.#messageListeners.clear();
        const listeners = [...this.#disconnectListeners];
        this.#disconnectListeners.clear();
        for (const listener of listeners) {
            this.#notifyListener(listener, error);
        }
    }

    #notifyListener<T>(listener: (value: T) => void, value: T): void {
        try {
            listener(value);
        } catch (error) {
            this.#warn(error);
        }
    }

    #warn(error: unknown): void {
        console.warn(error instanceof Error ? error : new Error(String(error)));
    }

    abstract close(): void;
    abstract send(message: JsonValue): Promise<void>;
}

export interface WorkerRpcConnector {
    attach?(channel: WorkerRpcChannel): void;
    connect(signal?: AbortSignal): Promise<WorkerRpcChannel>;
    detach?(channel?: WorkerRpcChannel): void;
}

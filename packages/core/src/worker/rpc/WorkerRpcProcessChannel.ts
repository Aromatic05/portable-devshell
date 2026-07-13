import { FrameReader, FrameWriter, type JsonValue } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import { WorkerRpcProcessAdapter } from "./WorkerRpcProcessAdapter.js";
import type { WorkerRpcChannel, WorkerRpcConnector } from "./WorkerRpcChannel.js";

export class WorkerRpcProcessConnector implements WorkerRpcConnector {
    readonly #transport: WorkerCommandTransport;
    readonly #options: WorkerRpcOptions;

    constructor(transport: WorkerCommandTransport, options: WorkerRpcOptions) {
        this.#transport = transport;
        this.#options = options;
    }

    async connect(): Promise<WorkerRpcChannel> {
        return new WorkerRpcProcessChannel(await WorkerRpcProcessAdapter.spawn(this.#transport, this.#options));
    }
}

export class WorkerRpcProcessChannel implements WorkerRpcChannel {
    readonly #process: WorkerRpcProcessAdapter;
    readonly #reader = new FrameReader();
    readonly #writer: FrameWriter;
    readonly #messageListeners = new Set<(message: JsonValue) => void>();
    readonly #disconnectListeners = new Set<(error: unknown) => void>();
    #disconnected = false;

    constructor(process: WorkerRpcProcessAdapter) {
        this.#process = process;
        this.#writer = new FrameWriter(process.stdin);
        process.stdout.on("data", this.#handleStdout);
        process.stdout.once("end", () => this.#disconnect(new Error("rpc process stdout ended")));
        process.stdout.once("error", (error) => this.#disconnect(error));
        process.stdin.once("error", (error) => this.#disconnect(error));
        process.exit
            .then((result) => {
                this.#disconnect(
                    new Error(
                        `rpc process exited with code ${String(result.code)} signal ${String(result.signal)}`
                    )
                );
            })
            .catch((error) => this.#disconnect(error));
    }

    async send(message: JsonValue): Promise<void> {
        if (this.#disconnected) {
            throw new Error("rpc process channel is disconnected");
        }
        await this.#writer.write(message);
    }

    onMessage(listener: (message: JsonValue) => void): () => void {
        this.#messageListeners.add(listener);
        return () => this.#messageListeners.delete(listener);
    }

    onDisconnect(listener: (error: unknown) => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => this.#disconnectListeners.delete(listener);
    }

    close(): void {
        if (!this.#disconnected) {
            this.#process.kill("SIGTERM");
        }
        this.#disconnect(new Error("rpc process channel closed"));
    }

    readonly #handleStdout = (chunk: Uint8Array): void => {
        try {
            for (const message of this.#reader.push(chunk)) {
                for (const listener of this.#messageListeners) {
                    listener(message);
                }
            }
        } catch (error) {
            this.#disconnect(error);
        }
    };

    #disconnect(error: unknown): void {
        if (this.#disconnected) {
            return;
        }
        this.#disconnected = true;
        this.#reader.reset();
        for (const listener of this.#disconnectListeners) {
            listener(error);
        }
    }
}

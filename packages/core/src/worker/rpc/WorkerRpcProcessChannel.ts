import type { JsonValue } from "@portable-devshell/shared";

import type { WorkerCommandTransport } from "../command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../command/WorkerCommandOptions.js";
import { WorkerRpcProcessAdapter } from "./WorkerRpcProcessAdapter.js";
import { WorkerRpcChannelBase, type WorkerRpcChannel, type WorkerRpcConnector } from "./WorkerRpcChannel.js";
import { WorkerRpcFrameReader, WorkerRpcFrameWriter } from "./WorkerRpcFrame.js";

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

export class WorkerRpcProcessChannel extends WorkerRpcChannelBase {
    readonly #process: WorkerRpcProcessAdapter;
    readonly #reader = new WorkerRpcFrameReader();
    readonly #writer: WorkerRpcFrameWriter;

    constructor(process: WorkerRpcProcessAdapter) {
        super();
        this.#process = process;
        this.#writer = new WorkerRpcFrameWriter(process.stdin);
        process.stdout.on("data", this.#handleStdout);
        process.stdout.once("end", () => this.#disconnect(new Error("rpc process stdout ended")));
        process.stdout.once("error", (error) => this.#disconnect(error));
        process.stdin.once("error", (error) => this.#disconnect(error));
        process.exit
            .then((result) => this.#disconnect(new Error(`rpc process exited with code ${String(result.code)} signal ${String(result.signal)}`)))
            .catch((error) => this.#disconnect(error));
    }

    async send(message: JsonValue): Promise<void> {
        if (this.disconnected) {
            throw new Error("rpc process channel is disconnected");
        }
        await this.#writer.write(message);
    }

    close(): void {
        if (!this.disconnected) {
            this.#process.kill("SIGTERM");
        }
        this.#disconnect(new Error("rpc process channel closed"));
    }

    readonly #handleStdout = (chunk: Uint8Array): void => {
        try {
            for (const message of this.#reader.push(chunk)) {
                this.emitMessage(message);
            }
        } catch (error) {
            this.#disconnect(error);
        }
    };

    #disconnect(error: unknown): void {
        this.notifyDisconnect(error, () => this.#reader.reset());
    }
}

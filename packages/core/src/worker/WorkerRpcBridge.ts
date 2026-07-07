import { FrameReader } from "../../../shared/dist/protocol/FrameReader.js";
import { FrameWriter } from "../../../shared/dist/protocol/FrameWriter.js";
import type { JsonValue } from "../../../shared/dist/types/JsonValue.js";

import type { WorkerCommandTransport } from "../provider/command/WorkerCommandTransport.js";
import type { WorkerRpcOptions } from "../provider/command/WorkerCommandOptions.js";
import { WorkerRpcError } from "../protocol/WorkerRpcError.js";
import type { WorkerRpcRequestEnvelope, WorkerRpcResponseEnvelope } from "../protocol/WorkerRpcEnvelope.js";
import { WorkerRpcProcessAdapter } from "./WorkerRpcProcessAdapter.js";

interface PendingResponse {
    resolve: (response: WorkerRpcResponseEnvelope) => void;
    reject: (error: unknown) => void;
}

type WorkerRpcResponseFrame = Record<string, JsonValue> & WorkerRpcResponseEnvelope;

export interface WorkerRpcBridgeOptions {
    transport: WorkerCommandTransport;
    rpcOptions: WorkerRpcOptions;
}

export class WorkerRpcBridge {
    readonly #transport: WorkerCommandTransport;
    readonly #rpcOptions: WorkerRpcOptions;
    readonly #reader = new FrameReader();
    #process?: WorkerRpcProcessAdapter;
    #writer?: FrameWriter;
    #spawnPromise?: Promise<WorkerRpcProcessAdapter>;
    #disconnectError?: WorkerRpcError;
    readonly #pending = new Map<string, PendingResponse>();

    constructor(options: WorkerRpcBridgeOptions) {
        this.#transport = options.transport;
        this.#rpcOptions = options.rpcOptions;
    }

    async connect(): Promise<void> {
        await this.#ensureProcess();
    }

    async request(request: WorkerRpcRequestEnvelope): Promise<WorkerRpcResponseEnvelope> {
        const process = await this.#ensureProcess();
        const writer = this.#writer;

        if (writer === undefined) {
            throw WorkerRpcError.disconnected({ instanceName: this.#rpcOptions.instanceName });
        }

        return await new Promise<WorkerRpcResponseEnvelope>(async (resolve, reject) => {
            this.#pending.set(request.id, { resolve, reject });

            try {
                await writer.write(request as unknown as JsonValue);
            } catch (error) {
                this.#pending.delete(request.id);
                this.#disconnect(this.#createDisconnectError(error));
                return;
            }

            void process;
        });
    }

    close(signal: NodeJS.Signals | number = "SIGTERM"): void {
        this.#process?.kill(signal);
        this.#disconnect(
            WorkerRpcError.disconnected({
                instanceName: this.#rpcOptions.instanceName,
                signal: typeof signal === "number" ? signal : String(signal)
            })
        );
    }

    async #ensureProcess(): Promise<WorkerRpcProcessAdapter> {
        if (this.#process !== undefined) {
            return this.#process;
        }

        if (this.#spawnPromise === undefined) {
            this.#spawnPromise = WorkerRpcProcessAdapter.spawn(this.#transport, this.#rpcOptions).then((process) => {
                this.#attachProcess(process);
                return process;
            });
        }

        return await this.#spawnPromise;
    }

    #attachProcess(process: WorkerRpcProcessAdapter): void {
        this.#reader.reset();
        this.#disconnectError = undefined;
        this.#process = process;
        this.#writer = new FrameWriter(process.stdin);
        process.stdout.on("data", this.#handleStdout);
        process.stdout.once("end", () => {
            this.#disconnect(
                WorkerRpcError.disconnected({
                    instanceName: this.#rpcOptions.instanceName,
                    reason: "stdout_end"
                })
            );
        });
        process.stdout.once("error", (error) => {
            this.#disconnect(this.#createDisconnectError(error));
        });
        process.stdin.once("error", (error) => {
            this.#disconnect(this.#createDisconnectError(error));
        });
        process.exit
            .then((result) => {
                this.#disconnect(
                    WorkerRpcError.disconnected(
                        {
                            instanceName: this.#rpcOptions.instanceName,
                            exitCode: result.code,
                            signal: result.signal ?? undefined
                        } as unknown as JsonValue
                    )
                );
            })
            .catch((error) => {
                this.#disconnect(this.#createDisconnectError(error));
            })
            .finally(() => {
                this.#spawnPromise = undefined;
            });
    }

    readonly #handleStdout = (chunk: Uint8Array): void => {
        try {
            const frames = this.#reader.push(chunk);

            for (const frame of frames) {
                if (!isWorkerRpcResponseEnvelope(frame)) {
                    continue;
                }

                const pending = this.#pending.get(frame.id);

                if (pending === undefined) {
                    continue;
                }

                this.#pending.delete(frame.id);
                pending.resolve(frame);
            }
        } catch (error) {
            this.#disconnect(this.#createDisconnectError(error));
        }
    };

    #disconnect(error: WorkerRpcError): void {
        if (this.#disconnectError !== undefined) {
            return;
        }

        this.#disconnectError = error;
        this.#process = undefined;
        this.#writer = undefined;
        this.#reader.reset();

        for (const [requestId, pending] of this.#pending) {
            this.#pending.delete(requestId);
            pending.reject(error);
        }
    }

    #createDisconnectError(cause: unknown): WorkerRpcError {
        const message = cause instanceof Error ? cause.message : String(cause);
        return WorkerRpcError.disconnected({
            instanceName: this.#rpcOptions.instanceName,
            cause: message
        });
    }
}

function isWorkerRpcResponseEnvelope(value: JsonValue): value is WorkerRpcResponseFrame {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }

    const candidate = value as Record<string, JsonValue>;
    return candidate.type === "response" && typeof candidate.id === "string" && typeof candidate.ok === "boolean";
}

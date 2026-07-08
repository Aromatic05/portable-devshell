import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import { FrameReader, FrameWriter, createError, errorCodes, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";

import { StreamBackpressure } from "../../stream/StreamBackpressure.js";
import { parseRouteTarget, type RouteTarget } from "../../route/RouteTarget.js";

interface RpcRequestEnvelope {
    id: string;
    method: string;
    params?: JsonValue;
    target: RouteTarget;
    type: "request";
}

interface RpcResponseEnvelope {
    error?: ControlErrorBody;
    id: string;
    ok: boolean;
    result?: JsonValue;
    type: "response";
}

interface RpcEventEnvelope {
    event: string;
    payload?: JsonValue;
    seq: number;
    target: RouteTarget;
    type: "event";
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class ControlRpcConnection {
    readonly #id = randomUUID();
    readonly #socket: Socket;
    readonly #reader = new FrameReader();
    readonly #writer: FrameWriter;
    readonly #backpressure = new StreamBackpressure();
    #closed = false;

    constructor(socket: Socket) {
        this.#socket = socket;
        this.#writer = new FrameWriter(socket);
    }

    get id(): string {
        return this.#id;
    }

    start(onRequest: (request: RpcRequestEnvelope) => Promise<void> | void, onClose: () => void): void {
        this.#socket.on("data", (chunk: Uint8Array) => {
            void this.#handleChunk(chunk, onRequest);
        });
        this.#socket.once("close", () => {
            this.#closed = true;
            onClose();
        });
        this.#socket.once("end", () => {
            this.#socket.destroy();
        });
        this.#socket.once("error", () => {
            this.#socket.destroy();
        });
    }

    async sendResponse(response: RpcResponseEnvelope): Promise<void> {
        await this.#write(response as unknown as JsonValue);
    }

    async sendEvent(event: RpcEventEnvelope): Promise<void> {
        await this.#write(event as unknown as JsonValue);
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        this.#closed = true;
        this.#socket.destroy();
    }

    async #handleChunk(chunk: Uint8Array, onRequest: (request: RpcRequestEnvelope) => Promise<void> | void): Promise<void> {
        let frames: JsonValue[];

        try {
            frames = this.#reader.push(chunk);
        } catch (error) {
            await this.#sendInvalidRequest(undefined, error instanceof Error ? error.message : String(error));
            this.close();
            return;
        }

        for (const frame of frames) {
            const parsed = this.#parseRequest(frame);

            if ("error" in parsed) {
                await this.#sendInvalidRequest(parsed.id, parsed.error.message, parsed.error);
                continue;
            }

            await onRequest(parsed.request);
        }
    }

    #parseRequest(frame: JsonValue):
        | {
              request: RpcRequestEnvelope;
          }
        | {
              error: Error;
              id?: string;
          } {
        if (!isRecord(frame)) {
            return { error: new Error("Envelope must be an object.") };
        }

        const id = typeof frame.id === "string" ? frame.id : undefined;

        if (frame.type !== "request" || typeof frame.method !== "string" || id === undefined) {
            return { error: new Error("Envelope must be a request."), id };
        }

        try {
            return {
                request: {
                    id,
                    method: frame.method,
                    params: frame.params,
                    target: parseRouteTarget(frame.target),
                    type: "request"
                }
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error : new Error(String(error)),
                id
            };
        }
    }

    async #sendInvalidRequest(id: string | undefined, message: string, error?: unknown): Promise<void> {
        await this.sendResponse({
            error:
                typeof error === "object" &&
                error !== null &&
                "code" in error &&
                typeof error.code === "string" &&
                "retryable" in error &&
                typeof error.retryable === "boolean"
                    ? (error as ControlErrorBody)
                    : createError({
                          code: errorCodes.envelopeInvalid,
                          message,
                          retryable: false
                      }),
            id: id ?? randomUUID(),
            ok: false,
            type: "response"
        });
    }

    async #write(value: JsonValue): Promise<void> {
        if (this.#closed) {
            return;
        }

        await this.#backpressure.push(async () => {
            if (this.#closed) {
                return;
            }

            try {
                await this.#writer.write(value);
            } catch {
                this.close();
            }
        });
    }
}

export type { RpcEventEnvelope, RpcRequestEnvelope, RpcResponseEnvelope };

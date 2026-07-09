import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";

import {
    type ControlEventEnvelope,
    FrameReader,
    FrameWriter,
    type ControlRelayInputEnvelope,
    type ControlRelayOutputEnvelope,
    type ControlRequestEnvelope,
    type ControlResponseEnvelope,
    createError,
    errorCodes,
    toControlErrorBody,
    type JsonValue
} from "@portable-devshell/shared";
import type { ControlClientKind } from "@portable-devshell/shared";

import { StreamBackpressure } from "../../stream/StreamBackpressure.js";
import { parseRouteTarget, type RouteTarget } from "../../route/RouteTarget.js";

type RpcRequestEnvelope = ControlRequestEnvelope & { target: RouteTarget };
type RpcResponseEnvelope = ControlResponseEnvelope;
type RpcEventEnvelope = ControlEventEnvelope & { target: RouteTarget };
type RpcRelayInputEnvelope = ControlRelayInputEnvelope;
type RpcRelayOutputEnvelope = ControlRelayOutputEnvelope;

export interface ControlRpcRelaySession {
    closeInput(): void;
    writeInput(chunk: Buffer): void;
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
    readonly #relaySessions = new Map<string, ControlRpcRelaySession>();
    #clientKind: ControlClientKind = "unknown";
    #closed = false;

    constructor(socket: Socket) {
        this.#socket = socket;
        this.#writer = new FrameWriter(socket);
    }

    get id(): string {
        return this.#id;
    }

    get clientKind(): ControlClientKind {
        return this.#clientKind;
    }

    identifyClient(clientKind: ControlClientKind): void {
        this.#clientKind = clientKind;
    }

    start(onRequest: (request: RpcRequestEnvelope) => Promise<void> | void, onClose: () => void): void {
        this.#socket.on("data", (chunk: Uint8Array) => {
            void this.#handleChunk(chunk, onRequest);
        });
        this.#socket.once("close", () => {
            for (const session of this.#relaySessions.values()) {
                session.closeInput();
            }
            this.#relaySessions.clear();
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

    async sendRelayOutput(id: string, chunk: string): Promise<void> {
        await this.#write({
            data: chunk,
            id,
            type: "relay.output"
        } as unknown as JsonValue);
    }

    registerRelaySession(id: string, session: ControlRpcRelaySession): void {
        this.#relaySessions.set(id, session);
    }

    unregisterRelaySession(id: string): void {
        this.#relaySessions.delete(id);
    }

    close(): void {
        if (this.#closed) {
            return;
        }

        for (const session of this.#relaySessions.values()) {
            session.closeInput();
        }
        this.#relaySessions.clear();
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
            const parsed = this.#parseFrame(frame);

            if ("error" in parsed) {
                await this.#sendInvalidRequest(parsed.id, parsed.error.message, parsed.error);
                continue;
            }

            if ("relayInput" in parsed) {
                const session = this.#relaySessions.get(parsed.relayInput.id);
                if (session === undefined) {
                    continue;
                }

                if (parsed.relayInput.eof === true) {
                    session.closeInput();
                    continue;
                }

                session.writeInput(Buffer.from(parsed.relayInput.data ?? "", "base64"));
                continue;
            }

            await onRequest(parsed.request);
        }
    }

    #parseFrame(frame: JsonValue):
        | {
              request: RpcRequestEnvelope;
          }
        | {
              relayInput: RpcRelayInputEnvelope;
          }
        | {
              error: Error;
              id?: string;
          } {
        if (!isRecord(frame)) {
            return { error: new Error("Envelope must be an object.") };
        }

        const id = typeof frame.id === "string" ? frame.id : undefined;

        if (frame.type === "relay.input") {
            if (id === undefined) {
                return { error: new Error("Relay input requires an id.") };
            }

            if (frame.eof === true) {
                return {
                    relayInput: {
                        eof: true,
                        id,
                        type: "relay.input"
                    }
                };
            }

            if (typeof frame.data !== "string") {
                return { error: new Error("Relay input requires base64 data or eof."), id };
            }

            return {
                relayInput: {
                    data: frame.data,
                    id,
                    type: "relay.input"
                }
            };
        }

        if (frame.type !== "request" || typeof frame.method !== "string" || id === undefined) {
            return { error: new Error("Envelope must be a request."), id };
        }

        try {
            return {
                request: {
                    id,
                    method: frame.method as ControlRequestEnvelope["method"],
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
        const errorBody = toControlErrorBody(error);

        await this.sendResponse({
            error:
                errorBody ??
                createError({
                    code: errorCodes.envelopeInvalid,
                    cause: error,
                    message,
                    retryable: false
                }).toBody(),
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

export type { RpcEventEnvelope, RpcRelayOutputEnvelope, RpcRequestEnvelope, RpcResponseEnvelope };

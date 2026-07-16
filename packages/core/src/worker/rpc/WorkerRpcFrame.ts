import type { Writable } from "node:stream";

import {
    createError,
    type ErrorCode,
    type JsonValue
} from "@portable-devshell/shared";
import { encodeFrame, FrameBuffer } from "@portable-devshell/shared/transport/frame";

export class WorkerRpcFrameReader {
    readonly #frames = new FrameBuffer();

    push(chunk: Uint8Array): JsonValue[] {
        return this.#frames.push(chunk).map(decodeJson);
    }

    reset(): void {
        this.#frames.reset();
    }
}

export class WorkerRpcFrameWriter {
    readonly #writable: Writable;

    constructor(writable: Writable) {
        this.#writable = writable;
    }

    async write(value: JsonValue): Promise<void> {
        const frame = encodeFrame(Buffer.from(JSON.stringify(value), "utf8"));
        await new Promise<void>((resolve, reject) => {
            this.#writable.write(frame, (error) => error == null ? resolve() : reject(error));
        });
    }
}

function decodeJson(payload: Uint8Array): JsonValue {
    if (payload.byteLength === 0) {
        throw protocolError("protocol.invalidJson", "Frame payload must not be empty.");
    }
    try {
        return JSON.parse(Buffer.from(payload).toString("utf8")) as JsonValue;
    } catch (error) {
        throw protocolError(
            "protocol.invalidJson",
            `Frame payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function protocolError(code: string, message: string): Error {
    return createError({ code: code as ErrorCode, message, retryable: false });
}

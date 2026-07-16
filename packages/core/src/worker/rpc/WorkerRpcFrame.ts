import type { Writable } from "node:stream";

import { createError, type ErrorCode, type JsonValue } from "@portable-devshell/shared";

const FRAME_HEADER_SIZE = 4;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

export class WorkerRpcFrameReader {
    #buffer = Buffer.alloc(0);

    push(chunk: Uint8Array): JsonValue[] {
        if (chunk.byteLength === 0) {
            return [];
        }
        const normalized = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.#buffer = this.#buffer.byteLength === 0
            ? Buffer.from(normalized)
            : Buffer.concat([this.#buffer, normalized]);

        const messages: JsonValue[] = [];
        while (this.#buffer.byteLength >= FRAME_HEADER_SIZE) {
            const payloadLength = this.#buffer.readUInt32BE(0);
            if (payloadLength > MAX_FRAME_SIZE) {
                throw protocolError("protocol.frameTooLarge", `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`);
            }
            const frameLength = FRAME_HEADER_SIZE + payloadLength;
            if (this.#buffer.byteLength < frameLength) {
                break;
            }
            const payload = this.#buffer.subarray(FRAME_HEADER_SIZE, frameLength);
            this.#buffer = this.#buffer.subarray(frameLength);
            if (payload.byteLength === 0) {
                throw protocolError("protocol.invalidJson", "Frame payload must not be empty.");
            }
            try {
                messages.push(JSON.parse(payload.toString("utf8")) as JsonValue);
            } catch (error) {
                throw protocolError(
                    "protocol.invalidJson",
                    `Frame payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
                );
            }
        }
        return messages;
    }

    reset(): void {
        this.#buffer = Buffer.alloc(0);
    }
}

export class WorkerRpcFrameWriter {
    readonly #writable: Writable;

    constructor(writable: Writable) {
        this.#writable = writable;
    }

    async write(value: JsonValue): Promise<void> {
        const payload = Buffer.from(JSON.stringify(value), "utf8");
        if (payload.byteLength > MAX_FRAME_SIZE) {
            throw protocolError("protocol.frameTooLarge", `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`);
        }
        const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.byteLength);
        frame.writeUInt32BE(payload.byteLength, 0);
        payload.copy(frame, FRAME_HEADER_SIZE);
        await new Promise<void>((resolve, reject) => {
            this.#writable.write(frame, (error) => {
                if (error != null) {
                    reject(error);
                    return;
                }
                resolve();
            });
        });
    }
}

function protocolError(code: string, message: string): Error {
    return createError({
        code: code as ErrorCode,
        message,
        retryable: false
    });
}

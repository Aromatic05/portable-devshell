import type { JsonValue } from "../types/JsonValue.js";
import { FrameCodec } from "./FrameCodec.js";
import { FRAME_HEADER_SIZE } from "./ProtocolLimits.js";

export class FrameReader {
    #buffer: Uint8Array = Buffer.alloc(0);

    get bufferedByteLength(): number {
        return this.#buffer.byteLength;
    }

    push(chunk: Uint8Array): JsonValue[] {
        if (chunk.byteLength === 0) {
            return [];
        }

        const normalizedChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        this.#buffer =
            this.#buffer.byteLength === 0
                ? Buffer.from(normalizedChunk)
                : Buffer.concat([this.#buffer, normalizedChunk]);

        const frames: JsonValue[] = [];

        while (this.#buffer.byteLength >= FRAME_HEADER_SIZE) {
            const payloadLength = FrameCodec.decodeFrameLength(this.#buffer.subarray(0, FRAME_HEADER_SIZE));
            const frameLength = FRAME_HEADER_SIZE + payloadLength;

            if (this.#buffer.byteLength < frameLength) {
                break;
            }

            const frame = this.#buffer.subarray(0, frameLength);
            frames.push(FrameCodec.decode(frame));
            this.#buffer = this.#buffer.subarray(frameLength);
        }

        return frames;
    }

    reset(): void {
        this.#buffer = Buffer.alloc(0);
    }
}

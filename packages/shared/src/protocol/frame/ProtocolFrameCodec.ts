import type { ErrorCode } from "../../error/ErrorCodeCatalog.js";
import { createError } from "../../error/ErrorFactoryCreate.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import { FRAME_HEADER_SIZE, MAX_FRAME_SIZE } from "./ProtocolFrameLimits.js";

const protocolErrorCodes = {
    frameTooLarge: "protocol.frameTooLarge",
    invalidFrame: "protocol.invalidFrame",
    invalidJson: "protocol.invalidJson"
} as const;

function createProtocolError(
    code: (typeof protocolErrorCodes)[keyof typeof protocolErrorCodes],
    message: string,
    details?: JsonValue
) {
    return createError({
        code: code as ErrorCode,
        details,
        message,
        retryable: false
    });
}

function toBuffer(value: Uint8Array): Buffer {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export class FrameCodec {
    static decode(frame: Uint8Array): JsonValue {
        const payload = this.decodePayload(frame);

        if (payload.byteLength === 0) {
            throw createProtocolError(
                protocolErrorCodes.invalidJson,
                "Frame payload must not be empty."
            );
        }

        try {
            return JSON.parse(payload.toString("utf8")) as JsonValue;
        } catch (error) {
            throw createProtocolError(protocolErrorCodes.invalidJson, "Frame payload is not valid JSON.", {
                cause: error instanceof Error ? error.message : "unknown"
            });
        }
    }

    static decodeFrameLength(header: Uint8Array): number {
        const normalizedHeader = toBuffer(header);
        if (normalizedHeader.byteLength < FRAME_HEADER_SIZE) {
            throw createProtocolError(
                protocolErrorCodes.invalidFrame,
                "Frame header is incomplete."
            );
        }

        const payloadLength = normalizedHeader.readUInt32BE(0);
        if (payloadLength > MAX_FRAME_SIZE) {
            throw createProtocolError(
                protocolErrorCodes.frameTooLarge,
                `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`,
                {
                    frameSize: payloadLength,
                    maxFrameSize: MAX_FRAME_SIZE
                }
            );
        }

        return payloadLength;
    }

    static decodePayload(frame: Uint8Array): Buffer {
        const normalizedFrame = toBuffer(frame);
        const payloadLength = this.decodeFrameLength(normalizedFrame);
        const expectedFrameLength = FRAME_HEADER_SIZE + payloadLength;

        if (normalizedFrame.byteLength !== expectedFrameLength) {
            throw createProtocolError(
                protocolErrorCodes.invalidFrame,
                "Frame length does not match payload length.",
                {
                    actualFrameSize: normalizedFrame.byteLength,
                    expectedFrameSize: expectedFrameLength
                }
            );
        }

        return normalizedFrame.subarray(FRAME_HEADER_SIZE);
    }

    static encode(value: JsonValue): Buffer {
        const payload = Buffer.from(JSON.stringify(value), "utf8");
        return this.encodePayload(payload);
    }

    static encodePayload(payload: Uint8Array): Buffer {
        const normalizedPayload = toBuffer(payload);
        if (normalizedPayload.byteLength > MAX_FRAME_SIZE) {
            throw createProtocolError(
                protocolErrorCodes.frameTooLarge,
                `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`,
                {
                    frameSize: normalizedPayload.byteLength,
                    maxFrameSize: MAX_FRAME_SIZE
                }
            );
        }

        const frame = Buffer.alloc(FRAME_HEADER_SIZE + normalizedPayload.byteLength);
        frame.writeUInt32BE(normalizedPayload.byteLength, 0);
        normalizedPayload.copy(frame, FRAME_HEADER_SIZE);
        return frame;
    }
}

import { createError, type ErrorCode, type JsonValue } from "@portable-devshell/shared";

const FRAME_HEADER_SIZE = 4;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;

export class ReverseRpcFrameCodec {
    static encode(value: JsonValue): Buffer {
        const payload = Buffer.from(JSON.stringify(value), "utf8");
        if (payload.byteLength > MAX_FRAME_SIZE) {
            throw protocolError(
                "protocol.frameTooLarge",
                `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`
            );
        }

        const frame = Buffer.allocUnsafe(FRAME_HEADER_SIZE + payload.byteLength);
        frame.writeUInt32BE(payload.byteLength, 0);
        payload.copy(frame, FRAME_HEADER_SIZE);
        return frame;
    }

    static decode(frame: Uint8Array): JsonValue {
        const normalized = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
        if (normalized.byteLength < FRAME_HEADER_SIZE) {
            throw protocolError("protocol.invalidFrame", "Frame header is incomplete.");
        }

        const payloadLength = normalized.readUInt32BE(0);
        if (payloadLength > MAX_FRAME_SIZE) {
            throw protocolError(
                "protocol.frameTooLarge",
                `Frame payload exceeds ${MAX_FRAME_SIZE} bytes.`
            );
        }
        if (normalized.byteLength !== FRAME_HEADER_SIZE + payloadLength) {
            throw protocolError("protocol.invalidFrame", "Frame length does not match payload length.");
        }

        const payload = normalized.subarray(FRAME_HEADER_SIZE);
        if (payload.byteLength === 0) {
            throw protocolError("protocol.invalidJson", "Frame payload must not be empty.");
        }

        try {
            return JSON.parse(payload.toString("utf8")) as JsonValue;
        } catch (error) {
            throw protocolError(
                "protocol.invalidJson",
                `Frame payload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}

function protocolError(code: string, message: string): Error {
    return createError({
        code: code as ErrorCode,
        message,
        retryable: false
    });
}

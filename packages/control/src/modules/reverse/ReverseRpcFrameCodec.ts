import {
    createError,
    type ErrorCode,
    type JsonValue
} from "@portable-devshell/shared";
import { decodeFrame, encodeFrame } from "@portable-devshell/shared/internal/frame";

export class ReverseRpcFrameCodec {
    static encode(value: JsonValue): Buffer {
        return encodeFrame(Buffer.from(JSON.stringify(value), "utf8"));
    }

    static decode(frame: Uint8Array): JsonValue {
        const payload = decodeFrame(frame);
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
    return createError({ code: code as ErrorCode, message, retryable: false });
}

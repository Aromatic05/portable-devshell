import {
    createError,
    errorCodes,
    ProtocolControlStream,
    type ControlStreamGapEnvelope,
    type JsonValue,
    type ProtocolControlStreamMessage
} from "@portable-devshell/shared";

export type TuiControlStreamMessage = ProtocolControlStreamMessage;
export class TuiControlStream extends ProtocolControlStream {}

export function asStreamGapError(message: ControlStreamGapEnvelope): Error {
    return createError({
        code: errorCodes.streamGap,
        message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
        retryable: true,
        details: message.payload as unknown as JsonValue
    });
}

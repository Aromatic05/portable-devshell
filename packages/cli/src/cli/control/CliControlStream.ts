import {
    createError,
    errorCodes,
    ProtocolControlStream,
    type ControlEventEnvelope,
    type ControlRpcInstanceListEntry,
    type ControlRpcInstanceLogEntry,
    type ControlRpcInstanceSnapshotEnvelope,
    type JsonValue,
    type ProtocolControlStreamMessage
} from "@portable-devshell/shared";

export type CliControlStreamMessage = ProtocolControlStreamMessage;
export type CliInstanceSnapshotEnvelope = ControlRpcInstanceSnapshotEnvelope;
export type CliInstanceListEntry = ControlRpcInstanceListEntry;
export type CliInstanceLogEntry = ControlRpcInstanceLogEntry;

export class CliControlStream extends ProtocolControlStream {
    async nextEvent(): Promise<ControlEventEnvelope> {
        const message = await this.nextMessage();
        if (message.kind === "instance.event") {
            return message.envelope;
        }
        if (message.kind === "stream.gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: message.envelope.payload as unknown as JsonValue
            });
        }
        if (message.kind === "stream.cancelled") {
            throw new Error(`stream.cancelled:${message.envelope.payload.reason}`);
        }
        throw new Error("control connection closed");
    }
}

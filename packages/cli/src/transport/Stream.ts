import {
    STREAM_GAP_CODE,
    createRemoteError,
    type InstanceEventRecord,
    type InstanceEventStreamPort,
    type JsonValue,
    type StreamMessage,
} from "@portable-devshell/shared";

export class CliClientEventStream<
    Event extends InstanceEventRecord = InstanceEventRecord,
> {
    readonly #stream: InstanceEventStreamPort<Event>;
    #closed = false;

    constructor(stream: InstanceEventStreamPort<Event>) {
        this.#stream = stream;
    }

    async nextEvent(): Promise<Event> {
        const message = await this.#stream.next();
        if (message.kind === "event") return message.event;
        if (message.kind === "gap") {
            throw createRemoteError({
                code: STREAM_GAP_CODE,
                message:
                    "Requested event sequence is no longer available. Pull a fresh snapshot.",
                retryable: true,
                details: gapDetails(message),
            });
        }
        if (message.error !== undefined) throw message.error;
        throw new Error("control stream completed");
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#stream.close();
    }
}

function gapDetails<Event>(
    message: Extract<StreamMessage<Event>, { kind: "gap" }>,
): JsonValue {
    return (
        message.details ?? {
            latestSeq: message.gap.lastSeq,
            oldestAvailableSeq: message.gap.nextSeq,
            requestedFromSeq: message.gap.fromSeq,
        }
    );
}

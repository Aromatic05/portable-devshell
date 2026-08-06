import {
    createError,
    errorCodes,
    type InstanceEvent,
    type InstanceEventStreamPort,
    type InstanceStreamMessage,
    type JsonValue,
} from "@portable-devshell/shared";

export class CliClientEventStream {
    readonly #stream: InstanceEventStreamPort;
    #closed = false;

    constructor(stream: InstanceEventStreamPort) {
        this.#stream = stream;
    }

    async nextEvent(): Promise<InstanceEvent> {
        const message = await this.#stream.next();
        if (message.kind === "event") return message.event;
        if (message.kind === "gap") {
            throw createError({
                code: errorCodes.streamGap,
                message: "Requested event sequence is no longer available. Pull a fresh snapshot.",
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

function gapDetails(
    message: Extract<InstanceStreamMessage, { kind: "gap" }>,
): JsonValue {
    return message.details ?? {
        ...(message.fromSeq === undefined ? {} : { fromSeq: message.fromSeq }),
        ...(message.lastSeq === undefined ? {} : { lastSeq: message.lastSeq }),
        ...(message.nextSeq === undefined ? {} : { nextSeq: message.nextSeq }),
    };
}

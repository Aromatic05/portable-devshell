import type { ToolCallRecordEventType } from "./Event.js";
import type {
    CommandResult,
    JsonValue,
    ToolCallContext,
} from "@portable-devshell/shared";

import type { LogQuery } from "../../../audit/Api.js";
import type {
    InstanceLogEntry,
    AuditLogs,
} from "../../../audit/Api.js";
import { toEventData } from "./Event.js";

const LOG_CHUNK_BYTES = 256 * 1024;

interface WorkerInstanceToolLogOptions {
    appendEvent(
        type: ToolCallRecordEventType,
        data?: JsonValue,
    ): Promise<unknown>;
    logStore: AuditLogs;
}

export class WorkerInstanceToolLog {
    readonly #appendEvent: WorkerInstanceToolLogOptions["appendEvent"];
    readonly #logStore: AuditLogs;

    constructor(options: WorkerInstanceToolLogOptions) {
        this.#appendEvent = options.appendEvent;
        this.#logStore = options.logStore;
    }

    async read(query: LogQuery = {}): Promise<InstanceLogEntry[]> {
        return await this.#logStore.read(query);
    }

    async append(
        result: Pick<CommandResult, "stderr" | "stdout">,
        context: {
            callId: string;
            requestId?: string;
            ctxId?: string;
            source: ToolCallContext["source"];
            toolName: string;
        },
    ): Promise<void> {
        const at = new Date().toISOString();
        const logContext = {
            callId: context.callId,
            ...(context.requestId === undefined
                ? {}
                : { requestId: context.requestId }),
            ...(context.ctxId === undefined ? {} : { ctxId: context.ctxId }),
            source: context.source,
            toolName: context.toolName,
        };

        if (result.stdout.length > 0) {
            const bytes = await this.#appendStream(
                "stdout",
                result.stdout,
                at,
                logContext,
            );
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...logContext,
                    bytes,
                    preview: readPreview(result.stdout),
                    stream: "stdout",
                    tail: readTail(result.stdout),
                }),
            );
        }

        if (result.stderr.length > 0) {
            const bytes = await this.#appendStream(
                "stderr",
                result.stderr,
                at,
                logContext,
            );
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...logContext,
                    bytes,
                    preview: readPreview(result.stderr),
                    stream: "stderr",
                    tail: readTail(result.stderr),
                }),
            );
        }
    }

    async #appendStream(
        stream: InstanceLogEntry["stream"],
        message: string,
        at: string,
        context: Pick<
            InstanceLogEntry,
            "callId" | "requestId" | "ctxId" | "source" | "toolName"
        >,
    ): Promise<number> {
        let bytes = 0;
        for (const chunk of logChunks(message)) {
            bytes += Buffer.byteLength(chunk, "utf8");
            await this.#logStore.append(stream, chunk, at, context);
        }
        return bytes;
    }
}

function* logChunks(message: string): Generator<string> {
    const bytes = Buffer.from(message, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
        let end = Math.min(bytes.length, offset + LOG_CHUNK_BYTES);
        // A chunk boundary must precede the complete next UTF-8 code point.
        while (end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
        yield bytes.subarray(offset, end).toString("utf8");
        offset = end;
    }
}

function readPreview(value: string): string {
    return value.slice(0, 160);
}

function readTail(value: string): string {
    return value.slice(-160);
}

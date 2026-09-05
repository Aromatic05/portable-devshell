import type { CommandResult, JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { InstanceEventInput } from "../../../instance/event/InstanceEventBuffer.js";
import type { LogQuery } from "../../../log/LogQuery.js";
import type { InstanceLogEntry, LogStoreInstance } from "../../../log/store/LogStoreInstance.js";
import { toEventData } from "../WorkerInstanceEvent.js";

const LOG_CHUNK_CODE_UNITS = 256 * 1024;

interface WorkerInstanceToolLogOptions {
    appendEvent(type: InstanceEventInput["type"], data?: JsonValue): Promise<unknown>;
    logStore: LogStoreInstance;
}

export class WorkerInstanceToolLog {
    readonly #appendEvent: WorkerInstanceToolLogOptions["appendEvent"];
    readonly #logStore: LogStoreInstance;

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
        }
    ): Promise<void> {
        const at = new Date().toISOString();

        if (result.stdout.length > 0) {
            const bytes = await this.#appendStream("stdout", result.stdout, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes,
                    preview: readPreview(result.stdout),
                    stream: "stdout",
                    tail: readTail(result.stdout)
                })
            );
        }

        if (result.stderr.length > 0) {
            const bytes = await this.#appendStream("stderr", result.stderr, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes,
                    preview: readPreview(result.stderr),
                    stream: "stderr",
                    tail: readTail(result.stderr)
                })
            );
        }
    }

    async #appendStream(
        stream: InstanceLogEntry["stream"],
        message: string,
        at: string,
        context: Pick<InstanceLogEntry, "callId" | "requestId" | "ctxId" | "source" | "toolName">,
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
    let offset = 0;
    while (offset < message.length) {
        let end = Math.min(message.length, offset + LOG_CHUNK_CODE_UNITS);
        if (
            end < message.length &&
            isHighSurrogate(message.charCodeAt(end - 1)) &&
            isLowSurrogate(message.charCodeAt(end))
        ) {
            end -= 1;
        }
        yield message.slice(offset, end);
        offset = end;
    }
}

function isHighSurrogate(value: number): boolean {
    return value >= 0xd800 && value <= 0xdbff;
}

function isLowSurrogate(value: number): boolean {
    return value >= 0xdc00 && value <= 0xdfff;
}

function readPreview(value: string): string {
    return value.slice(0, 160);
}

function readTail(value: string): string {
    return value.slice(-160);
}

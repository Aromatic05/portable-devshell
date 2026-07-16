import type { CommandResult, JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { InstanceEventInput } from "../../../instance/event/InstanceEventBuffer.js";
import type { LogQuery } from "../../../log/LogQuery.js";
import type { InstanceLogEntry, LogStoreInstance } from "../../../log/store/LogStoreInstance.js";
import { toEventData } from "../WorkerInstanceEvent.js";
import { readByteLength } from "./WorkerInstanceToolResult.js";

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
            await this.#logStore.append("stdout", result.stdout, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stdout),
                    preview: readPreview(result.stdout),
                    stream: "stdout",
                    tail: readTail(result.stdout)
                })
            );
        }

        if (result.stderr.length > 0) {
            await this.#logStore.append("stderr", result.stderr, at, context);
            await this.#appendEvent(
                "log.appended",
                toEventData({
                    ...context,
                    bytes: readByteLength(result.stderr),
                    preview: readPreview(result.stderr),
                    stream: "stderr",
                    tail: readTail(result.stderr)
                })
            );
        }
    }
}

function readPreview(value: string): string {
    return value.slice(0, 160);
}

function readTail(value: string): string {
    return value.slice(-160);
}

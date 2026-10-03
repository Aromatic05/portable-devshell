import {
    Endpoint,
    Event,
    Rpc,
    createRemoteError,
    runtimeErrorCodes,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";

import { WorkerToolCatalog } from "./Catalog.js";

export class WorkerToolInvoker {
    readonly #catalog: WorkerToolCatalog;
    readonly #endpoint: Endpoint;
    readonly #workerHost: string;

    constructor(endpoint: Endpoint, workerHost: string, catalog: WorkerToolCatalog) {
        this.#endpoint = endpoint;
        this.#workerHost = workerHost;
        this.#catalog = catalog;
    }

    async invoke(
        toolName: string,
        input: JsonValue,
        context?: ToolCallContext,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void,
    ): Promise<JsonValue> {
        if (this.#catalog.getTool(toolName) === undefined)
            throw createRemoteError({
                code: runtimeErrorCodes.toolSchemaUnavailable,
                message: `Tool ${toolName} is not available for this instance.`,
                retryable: false,
                details: { toolName },
            });

        const operationId = context?.operationId ?? randomUUID();
        const connection = await this.#endpoint.connect(
            this.#workerHost,
            "tool",
            signal,
        );
        const rpc = new Rpc(connection);
        const events = new Event(connection);
        const off =
            onProgress === undefined
                ? undefined
                : events.onEvent((name, message) => {
                      if (
                          name === "progress" &&
                          isRecord(message) &&
                          message.operationId === operationId &&
                          message.value !== undefined
                      )
                          onProgress(message.value as JsonValue);
                  });
        try {
            return (await rpc.request(
                toolName,
                {
                    context: { ...(context ?? {}), operationId },
                    input,
                },
                signal,
            )) as JsonValue;
        } finally {
            off?.();
            events.close();
            rpc.close();
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

import { createError, errorCodes, type JsonValue, type ToolCallContext } from "@portable-devshell/shared";

import { WorkerRpcClient } from "../rpc/WorkerRpcClient.js";
import { WorkerToolCatalog } from "./WorkerToolCatalog.js";

export class WorkerToolInvoker {
    readonly #rpcClient: WorkerRpcClient;
    readonly #catalog: WorkerToolCatalog;

    constructor(rpcClient: WorkerRpcClient, catalog: WorkerToolCatalog) {
        this.#rpcClient = rpcClient;
        this.#catalog = catalog;
    }

    async invoke(
        toolName: string,
        input: JsonValue,
        context?: ToolCallContext,
        signal?: AbortSignal,
        onProgress?: (progress: JsonValue) => void
    ): Promise<JsonValue> {
        const tool = this.#catalog.getTool(toolName);

        if (tool === undefined) {
            throw createError({
                code: errorCodes.coreToolSchemaUnavailable,
                message: `Tool ${toolName} is not available for this instance.`,
                retryable: false,
                details: { toolName }
            });
        }

        return await this.#rpcClient.request(toolName, input, context, signal, onProgress);
    }
}

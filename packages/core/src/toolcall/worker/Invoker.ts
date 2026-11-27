import {
    Endpoint,
    Event,
    Rpc,
    createRemoteError,
    runtimeErrorCodes,
    toRemoteErrorBody,
    TRANSPORT_RPC_RESULT_UNCERTAIN_CODE,
    type JsonValue,
    type ToolCallContext,
} from "@portable-devshell/shared";
import { randomUUID } from "node:crypto";

import { WorkerToolCatalog } from "./Catalog.js";

export class WorkerToolInvoker {
    readonly #catalog: WorkerToolCatalog;
    readonly #endpoint: Endpoint;
    readonly #workerHost: string;

    constructor(
        endpoint: Endpoint,
        workerHost: string,
        catalog: WorkerToolCatalog,
    ) {
        this.#endpoint = endpoint;
        this.#workerHost = workerHost;
        this.#catalog = catalog;
    }

    async confirmWaitLease(owner: string, task: string): Promise<boolean> {
        const result = await this.#waitLeaseRequest("process.wait.confirm", { owner, id: task });
        return isRecord(result) && result.retained === true;
    }

    async reconcileWaitLeases(owners: readonly string[]): Promise<void> {
        await this.#waitLeaseRequest("process.wait.reconcile", { owners: [...owners] });
    }

    async #waitLeaseRequest(method: string, input: JsonValue): Promise<JsonValue> {
        const connection = await this.#endpoint.connect(this.#workerHost, "core");
        const rpc = new Rpc(connection);
        try {
            return await rpc.request<JsonValue>(method, input);
        } finally {
            rpc.close();
        }
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
        const command = isRecord(input) ? input.command : undefined;
        const createsTask = toolName === "bash_run" || (toolName === "task_manage" && command === "create");
        const taskCreationId = createsTask ? `process-${randomUUID()}` : undefined;
        const awaitCancellationReply = createsTask || toolName === "task_input" ||
            (toolName === "task_manage" && command === "close");
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
                    context: {
                        ...(context ?? {}), operationId,
                        ...(taskCreationId === undefined ? {} : { taskCreationId }),
                    },
                    input,
                },
                signal,
                { awaitCancellationReply },
            )) as JsonValue;
        } catch (error) {
            const body = toRemoteErrorBody(error);
            if (taskCreationId !== undefined && body?.code === TRANSPORT_RPC_RESULT_UNCERTAIN_CODE)
                throw createRemoteError({
                    ...body, cause: error, retryable: false,
                    details: { taskId: taskCreationId, taskStart: "unknown" },
                });
            throw error;
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

import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import type { StreamSubscriptionManager } from "../../stream/StreamSubscriptionManager.js";
import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RouteHandlerInstanceOptions {
    instanceRegistry: InstanceRegistry;
    streamSubscriptionManager: StreamSubscriptionManager;
}

export class RouteHandlerInstance {
    readonly #instanceRegistry: InstanceRegistry;
    readonly #streamSubscriptionManager: StreamSubscriptionManager;

    constructor(options: RouteHandlerInstanceOptions) {
        this.#instanceRegistry = options.instanceRegistry;
        this.#streamSubscriptionManager = options.streamSubscriptionManager;
    }

    async handle(
        connection: ControlRpcConnection,
        method: string,
        requestId: string,
        instanceName: string,
        params?: JsonValue
    ): Promise<JsonValue> {
        const descriptor = this.#instanceRegistry.get(instanceName);

        if (descriptor === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                message: `Instance ${instanceName} was not found.`,
                retryable: false,
                details: { instance: instanceName }
            });
        }

        switch (method) {
            case "instance.getSnapshot":
                return {
                    lastSeq: descriptor.worker.snapshot().lastSeq,
                    snapshot: descriptor.worker.snapshot()
                } as unknown as JsonValue;
            case "instance.refreshStatus": {
                const snapshot = await descriptor.worker.refreshStatus();
                return {
                    lastSeq: snapshot.lastSeq,
                    snapshot
                } as unknown as JsonValue;
            }
            case "instance.start":
                return (await descriptor.worker.start(readWorkspacePath(params))) as unknown as JsonValue;
            case "instance.stop":
                return (await descriptor.worker.stop()) as unknown as JsonValue;
            case "instance.readLogs":
                return (await descriptor.worker.readLogs(readLogQuery(params))) as unknown as JsonValue;
            case "instance.subscribe":
                return await this.#streamSubscriptionManager.subscribe(
                    connection,
                    descriptor.name,
                    descriptor.worker,
                    readFromSeq(params)
                );
            case "instance.callTool": {
                const { input, toolName } = readToolCall(params);
                return (
                    await descriptor.worker.callTool(toolName, input, {
                        requestId,
                        sessionId: connection.id,
                        source: "cli"
                    })
                ) as unknown as JsonValue;
            }
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }
}

function readWorkspacePath(params?: JsonValue): string | undefined {
    if (!isRecord(params) || params.workspacePath === undefined) {
        return undefined;
    }

    return typeof params.workspacePath === "string" ? params.workspacePath : undefined;
}

function readLogQuery(params?: JsonValue): { fromSeq?: number; limit?: number } {
    if (!isRecord(params)) {
        return {};
    }

    return {
        fromSeq: typeof params.fromSeq === "number" ? params.fromSeq : undefined,
        limit: typeof params.limit === "number" ? params.limit : undefined
    };
}

function readFromSeq(params?: JsonValue): number {
    if (!isRecord(params) || typeof params.fromSeq !== "number") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "instance.subscribe requires numeric fromSeq.",
            retryable: false
        });
    }

    return params.fromSeq;
}

function readToolCall(params?: JsonValue): { input: JsonValue; toolName: string } {
    if (!isRecord(params) || typeof params.toolName !== "string") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "instance.callTool requires toolName.",
            retryable: false
        });
    }

    return {
        input: params.input ?? null,
        toolName: params.toolName
    };
}

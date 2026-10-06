import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";
import type {
    ControlPortContext,
    ControlPortDefinition,
    InstanceEventRecord,
    JsonValue,
    MessageStream,
    TaskEvent,
    TodoReadInput,
} from "@portable-devshell/shared";
import { isTaskEventType } from "@portable-devshell/shared";
import { routeModule } from "../../Port.js";
import type { TodoApi } from "../Api.js";
import type { InstanceEventSource } from "../../instance/Public.js";

interface TodoTaskRouteSubscriptionPort {
    subscribe(
        stream: MessageStream,
        context: ControlPortContext,
        instanceName: string,
        instance: Pick<InstanceEventSource, "subscribe">,
        fromSeq: number,
        projectEvent?: (event: InstanceEventRecord) => TaskEvent | undefined,
    ): Promise<void>;
}

interface TodoTaskRouteInstancePort {
    events: InstanceEventSource;
    name: string;
    todo: Pick<TodoApi, "delete" | "read">;
}







export function createTodoTaskRouteModule(
    instance: TodoTaskRouteInstancePort,
    subscriptions: TodoTaskRouteSubscriptionPort,
): ControlPortDefinition {
    return routeModule(
        "task",
        {
            getTodo: async (request) =>
                ({
                    lastSeq: instance.events.cursor(),
                    todo: await instance.todo.read(
                        readTodoInput(request.payload),
                    ),
                }) as unknown as JsonValue,
            deleteTodo: async (request) => {
                await instance.todo.delete(readTodoTaskId(request.payload));
                return {};
            },
        },
        {
            subscribe: async (stream, request, context) =>
                await subscriptions.subscribe(
                    stream,
                    context,
                    instance.name,
                    instance.events,
                    readTodoSubscriptionFromSeq(request.payload),
                    (event) =>
                        isTaskEventType(event.type)
                            ? (event as TaskEvent)
                            : undefined,
                ),
        },
    );
}

export function readTodoSubscriptionFromSeq(payload?: JsonValue): number {
    if (
        !isRecord(payload) ||
        typeof payload.fromSeq !== "number" ||
        !Number.isSafeInteger(payload.fromSeq) ||
        payload.fromSeq < 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.subscribe requires a non-negative integer fromSeq.",
            retryable: false,
        });
    }
    return payload.fromSeq;
}

export function readTodoInput(payload?: JsonValue): TodoReadInput | undefined {
    if (payload === undefined) return undefined;
    if (!isRecord(payload)) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.getTodo payload must be an object.",
            retryable: false,
        });
    }
    const keys = Object.keys(payload);
    if (keys.length === 0) return undefined;
    if (keys.length !== 1 || keys[0] !== "taskId") {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.getTodo accepts only the optional taskId selector.",
            retryable: false,
        });
    }
    const value = payload.taskId;
    if (typeof value !== "string" || value.trim().length === 0) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.getTodo taskId must be a non-empty string.",
            retryable: false,
        });
    }
    return { taskId: value.trim() };
}

export function readTodoTaskId(payload?: JsonValue): string {
    if (
        !isRecord(payload) ||
        typeof payload.taskId !== "string" ||
        payload.taskId.trim().length === 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "task.deleteTodo taskId must be a non-empty string.",
            retryable: false,
        });
    }
    return payload.taskId;
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

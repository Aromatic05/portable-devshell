import type { WorkerInstance } from "@portable-devshell/core";
import type {
    InstanceEvent,
    JsonValue,
    PrefixRouteContext,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";
import { createError, errorCodes } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import { readTodoSubscriptionFromSeq } from "./TodoRouteInput.js";
import type { TodoService } from "./TodoService.js";

export interface TodoRouteSubscriptionPort {
    subscribe(
        context: PrefixRouteContext,
        instanceName: string,
        instance: Pick<WorkerInstance, "subscribe">,
        fromSeq: number,
        eventFilter?: (event: InstanceEvent) => boolean
    ): Promise<void>;
}

export interface TodoRouteInstancePort {
    name: string;
    todo: Pick<TodoService, "addComment" | "deleteComment" | "read">;
    worker: Pick<WorkerInstance, "snapshot" | "subscribe">;
}

export function createTodoRouteModule(
    instance: TodoRouteInstancePort,
    subscriptions: TodoRouteSubscriptionPort
): PrefixRouteModuleDefinition {
    return routeModule("todo", {
        get: async () => ({
            lastSeq: instance.worker.snapshot().lastSeq,
            todo: await instance.todo.read()
        }) as unknown as JsonValue,
        addComment: async (request) => {
            const text = readCommentText(request.payload ?? null);
            await instance.todo.addComment(text);
            return undefined;
        },
        deleteComment: async (request) => {
            await instance.todo.deleteComment(readCommentId(request.payload ?? null));
            return undefined;
        },
        subscribe: async (request, context) => {
            await subscriptions.subscribe(
                context,
                instance.name,
                instance.worker,
                readTodoSubscriptionFromSeq(request.payload),
                (event) => event.type.startsWith("todo.")
            );
            return undefined;
        }
    });
}

function readCommentText(value: JsonValue): string {
    if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.text !== "string" || value.text.trim().length === 0) {
        throw createError({ code: errorCodes.targetInvalid, message: "todo.addComment requires non-empty text.", retryable: false });
    }
    return value.text.trim();
}

function readCommentId(value: JsonValue): string {
    if (typeof value !== "object" || value === null || Array.isArray(value) || typeof value.id !== "string" || value.id.trim().length === 0) {
        throw createError({ code: errorCodes.targetInvalid, message: "todo.deleteComment requires id.", retryable: false });
    }
    return value.id.trim();
}

import type { WorkerInstance } from "@portable-devshell/core";
import type {
    InstanceEvent,
    JsonValue,
    PrefixRouteContext,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../common/RouteModule.js";
import { readTodoSubscriptionFromSeq } from "./TodoInput.js";
import type { TodoService } from "./TodoService.js";

export interface TodoSubscriptionPort {
    subscribe(
        context: PrefixRouteContext,
        instanceName: string,
        instance: Pick<WorkerInstance, "subscribe">,
        fromSeq: number,
        eventFilter?: (event: InstanceEvent) => boolean
    ): Promise<void>;
}

export interface TodoInstancePort {
    name: string;
    todo: Pick<TodoService, "read">;
    worker: Pick<WorkerInstance, "snapshot" | "subscribe">;
}

export function createTodoModule(
    instance: TodoInstancePort,
    subscriptions: TodoSubscriptionPort
): PrefixRouteModuleDefinition {
    return routeModule("todo", {
        get: async () => ({
            lastSeq: instance.worker.snapshot().lastSeq,
            todo: await instance.todo.read()
        }) as unknown as JsonValue,
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

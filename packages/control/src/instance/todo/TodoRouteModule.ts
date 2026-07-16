import type { WorkerInstance } from "@portable-devshell/core";
import type {
    InstanceEvent,
    JsonValue,
    PrefixRouteContext,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

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
    todo: Pick<TodoService, "read">;
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

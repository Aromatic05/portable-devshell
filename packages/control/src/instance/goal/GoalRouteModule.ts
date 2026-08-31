import type { WorkerInstance } from "@portable-devshell/core";
import type { JsonValue, PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";
import type { GoalService } from "./GoalService.js";

export interface GoalRouteInstancePort {
    goal: Pick<GoalService, "list">;
    worker: Pick<WorkerInstance, "snapshot">;
}

export function createGoalRouteModule(instance: GoalRouteInstancePort): PrefixRouteModuleDefinition {
    return routeModule("goal", {
        get: async () => ({
            goals: await instance.goal.list(),
            lastSeq: instance.worker.snapshot().lastSeq,
        }) as unknown as JsonValue,
    });
}

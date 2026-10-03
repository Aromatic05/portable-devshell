import type { WorkerInstance } from "@portable-devshell/core";
import type {
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../../server/Route.js";
import type { GoalService } from "./Service.js";

export interface GoalTaskRouteInstancePort {
    goal: Pick<GoalService, "list">;
    worker: Pick<WorkerInstance, "snapshot">;
}

export function createGoalTaskRouteModule(
    instance: GoalTaskRouteInstancePort,
): ControlPortDefinition {
    return routeModule("task", {
        getGoals: async () =>
            ({
                goals: await instance.goal.list(),
                lastSeq: instance.worker.snapshot().lastSeq,
            }) as unknown as JsonValue,
    });
}

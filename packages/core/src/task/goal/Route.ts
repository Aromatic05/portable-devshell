import type {
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../Port.js";
import type { InstanceEventSource } from "../../instance/EventBuffer.js";
import type { GoalService } from "./Service.js";

export interface GoalTaskRouteInstancePort {
    events: Pick<InstanceEventSource, "cursor">;
    goal: Pick<GoalService, "list">;
}

export function createGoalTaskRouteModule(
    instance: GoalTaskRouteInstancePort,
): ControlPortDefinition {
    return routeModule("task", {
        getGoals: async () =>
            ({
                goals: await instance.goal.list(),
                lastSeq: instance.events.cursor(),
            }) as unknown as JsonValue,
    });
}

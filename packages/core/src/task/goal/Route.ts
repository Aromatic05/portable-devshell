import type { GoalTaskRouteInstancePort } from "../Api.js";
import type {
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../Port.js";





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

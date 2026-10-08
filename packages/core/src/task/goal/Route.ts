import type {
    InstanceEventSource,
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { createRemoteError, controlErrorCodes, routeModule } from "@portable-devshell/shared";
import type { GoalApi } from "../Api.js";

interface GoalTaskRouteInstancePort {
    events: Pick<InstanceEventSource, "cursor">;
    goal: Pick<GoalApi, "list" | "read">;
}





export function createGoalTaskRouteModule(
    instance: GoalTaskRouteInstancePort,
): ControlPortDefinition {
    return routeModule("task", {
        getGoal: async (request) => {
            const payload = request.payload;
            if (typeof payload !== "object" || payload === null || Array.isArray(payload) ||
                typeof payload.ctxId !== "string" || payload.ctxId.length === 0)
                throw createRemoteError({
                    code: controlErrorCodes.invalidTarget,
                    message: "task.getGoal requires a Context ID.",
                    retryable: false,
                });
            const lastSeq = instance.events.cursor();
            return {
                goal: (await instance.goal.read(payload.ctxId)) ?? null,
                lastSeq,
            } as unknown as JsonValue;
        },
        getGoals: async () =>
            ({
                goals: await instance.goal.list(),
                lastSeq: instance.events.cursor(),
            }) as unknown as JsonValue,
    });
}

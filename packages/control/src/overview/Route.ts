import type {
    JsonValue,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "@portable-devshell/shared";
import type { OperationalOverviewApi } from "./Api.js";

export function createOperationalOverviewRouteModule(
    overview: OperationalOverviewApi,
): ControlPortDefinition {
    return routeModule("overview", {
        get: async () => (await overview.read()) as unknown as JsonValue,
    });
}

import type {
    JsonValue,
    OperationalOverview,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface OperationalOverviewPort {
    read(): Promise<OperationalOverview>;
}

export function createOperationalOverviewRouteModule(
    overview: OperationalOverviewPort
): PrefixRouteModuleDefinition {
    return routeModule("overview", {
        get: async () => await overview.read() as unknown as JsonValue
    });
}

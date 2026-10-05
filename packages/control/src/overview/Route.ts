import type {
    JsonValue,
    OperationalOverview,
    ControlPortDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../Port.js";

export interface OperationalOverviewPort {
    read(): Promise<OperationalOverview>;
}

export function createOperationalOverviewRouteModule(
    overview: OperationalOverviewPort,
): ControlPortDefinition {
    return routeModule("overview", {
        get: async () => (await overview.read()) as unknown as JsonValue,
    });
}

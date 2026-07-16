import type { PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../route/ControlRouteFactory.js";
import { readReverseInstanceName } from "./ReverseRouteInput.js";
import type { ReverseControlService } from "./ReverseControlService.js";

export function createReverseRouteModule(service?: ReverseControlService): PrefixRouteModuleDefinition {
    const reverse = () => requirePort(service, "Reverse connection management is not available.");
    return routeModule("reverse", {
        createCode: async (request) => await reverse().createDeviceCode(
            readReverseInstanceName(request.payload)
        ) as never,
        rotateToken: async (request) => await reverse().rotateDeviceToken(
            readReverseInstanceName(request.payload)
        ) as never,
        revokeToken: async (request) => await reverse().revokeDeviceToken(
            readReverseInstanceName(request.payload)
        ) as never
    });
}

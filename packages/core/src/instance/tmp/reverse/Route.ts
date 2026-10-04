import type { ControlPortDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../server/Route.js";
import { readReverseInstanceName } from "./Input.js";
import type { ReverseCredentialService } from "@portable-devshell/core";

export function createConnectionRouteModule(
    service?: ReverseCredentialService,
): ControlPortDefinition {
    const connection = () =>
        requirePort(service, "Connection management is not available.");
    return routeModule("connection", {
        createCode: async (request) =>
            (await connection().createDeviceCode(
                readReverseInstanceName(request.payload),
            )) as never,
        rotateToken: async (request) =>
            (await connection().rotateDeviceToken(
                readReverseInstanceName(request.payload),
            )) as never,
        revokeToken: async (request) =>
            (await connection().revokeDeviceToken(
                readReverseInstanceName(request.payload),
            )) as never,
    });
}

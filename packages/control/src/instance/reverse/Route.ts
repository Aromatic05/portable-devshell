import {
    createRemoteError,
    controlErrorCodes,
    requirePort,
    routeModule,
    type ControlPortDefinition,
    type JsonValue,
} from "@portable-devshell/shared";

import type { ReverseCredentials } from "./Credentials.js";

export function createConnectionRouteModule(
    service?: ReverseCredentials,
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

function readReverseInstanceName(params?: JsonValue): string {
    if (
        typeof params !== "object" ||
        params === null ||
        Array.isArray(params) ||
        typeof params.instance !== "string" ||
        params.instance.length === 0
    ) {
        throw createRemoteError({
            code: controlErrorCodes.invalidTarget,
            message: "Reverse connection operation requires instance.",
            retryable: false,
        });
    }
    return params.instance;
}

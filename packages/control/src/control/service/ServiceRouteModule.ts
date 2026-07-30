import {
    CONTROL_PROTOCOL_VERSION,
    createError,
    errorCodes,
    type ControlClientKind,
    type ControlProtocolHelloRequest,
    type ControlProtocolHelloResponse,
    type JsonValue,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface ServiceRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceRouteModule(options: ServiceRouteModuleOptions): PrefixRouteModuleDefinition {
    return routeModule("service", {
        hello: (request, context) => negotiateProtocol(
            request.payload,
            context.peer
        ) as unknown as JsonValue,
        ping: () => ({ pong: true }),
        status: () => ({ instanceCount: options.instanceCount(), ok: true, pid: process.pid }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined) {
                context.afterReply(options.restart);
            }
            return { accepted: true };
        }
    });
}

function negotiateProtocol(
    payload: JsonValue | undefined,
    peer: ControlClientKind
): ControlProtocolHelloResponse {
    const request = readHelloRequest(payload);
    if (request.clientKind !== peer) {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: `service.hello clientKind ${request.clientKind} does not match ${peer}.`,
            retryable: false
        });
    }
    if (
        request.minProtocolVersion > CONTROL_PROTOCOL_VERSION ||
        request.maxProtocolVersion < CONTROL_PROTOCOL_VERSION
    ) {
        throw createError({
            code: errorCodes.protocolVersionUnsupported,
            details: {
                clientMaxProtocolVersion: request.maxProtocolVersion,
                clientMinProtocolVersion: request.minProtocolVersion,
                serverProtocolVersion: CONTROL_PROTOCOL_VERSION
            },
            message: "Control RPC protocol version is not supported.",
            retryable: false
        });
    }
    return {
        capabilities: ["request", "stream", "streamResume"],
        protocolVersion: CONTROL_PROTOCOL_VERSION
    };
}

function readHelloRequest(payload: JsonValue | undefined): ControlProtocolHelloRequest {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw invalidHello("service.hello requires an object payload.");
    }
    const clientKind = payload.clientKind;
    const minProtocolVersion = payload.minProtocolVersion;
    const maxProtocolVersion = payload.maxProtocolVersion;
    if (clientKind !== "cli" && clientKind !== "tui" && clientKind !== "web") {
        throw invalidHello("service.hello clientKind must be cli, tui, or web.");
    }
    if (!isProtocolVersion(minProtocolVersion) || !isProtocolVersion(maxProtocolVersion)) {
        throw invalidHello("service.hello protocol versions must be positive safe integers.");
    }
    if (minProtocolVersion > maxProtocolVersion) {
        throw invalidHello("service.hello minProtocolVersion must not exceed maxProtocolVersion.");
    }
    if (payload.clientVersion !== undefined && typeof payload.clientVersion !== "string") {
        throw invalidHello("service.hello clientVersion must be a string.");
    }
    return {
        clientKind,
        ...(payload.clientVersion === undefined ? {} : { clientVersion: payload.clientVersion }),
        maxProtocolVersion,
        minProtocolVersion
    };
}

function isProtocolVersion(value: JsonValue | undefined): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function invalidHello(message: string): Error {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false
    });
}

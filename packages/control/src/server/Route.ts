import {
    createRemoteError,
    controlErrorCodes,
    type ControlPortDefinition,
    type ControlPortHandler,
    type ControlPortStreamHandler,
    JsonValue,
} from "@portable-devshell/shared";

import { negotiateControlProtocol } from "./Protocol.js";

export function routeModule(
    name: string,
    operations: Record<string, ControlPortHandler>,
    streams: Record<string, ControlPortStreamHandler> = {},
): ControlPortDefinition {
    return {
        name,
        operations: Object.entries(operations).map(([operation, handle]) => ({
            name: operation,
            handle,
        })),
        ...(Object.keys(streams).length === 0
            ? {}
            : {
                  streams: Object.entries(streams).map(
                      ([operation, handle]) => ({
                          name: operation,
                          handle,
                      }),
                  ),
              }),
    };
}

export function requirePort<T>(port: T | undefined, message: string): T {
    if (port !== undefined) return port;
    throw createRemoteError({
        code: controlErrorCodes.methodNotFound,
        message,
        retryable: false,
    });
}

export interface ServerRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServerRouteModule(
    options: ServerRouteModuleOptions,
): ControlPortDefinition {
    return routeModule("server", {
        hello: (request, context) =>
            negotiateControlProtocol(
                request.payload,
                context.peer,
            ) as unknown as JsonValue,
        ping: () => ({ pong: true }),
        status: () => ({
            instanceCount: options.instanceCount(),
            ok: true,
            pid: process.pid,
        }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined)
                context.afterReply(options.restart);
            return { accepted: true };
        },
    });
}

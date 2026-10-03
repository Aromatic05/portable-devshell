import {
    createRemoteError,
    controlErrorCodes,
    type ControlPortDefinition,
    type ControlPortHandler,
    type ControlPortStreamHandler,
} from "@portable-devshell/shared";

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
                  streams: Object.entries(streams).map(([operation, handle]) => ({
                      name: operation,
                      handle,
                  })),
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

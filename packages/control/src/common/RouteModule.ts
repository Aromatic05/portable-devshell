import {
    createError,
    errorCodes,
    type PrefixRouteHandler,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

export function routeModule(
    name: string,
    operations: Record<string, PrefixRouteHandler>
): PrefixRouteModuleDefinition {
    return {
        name,
        operations: Object.entries(operations).map(([operation, handle]) => ({ name: operation, handle }))
    };
}

export function requirePort<T>(port: T | undefined, message: string): T {
    if (port !== undefined) {
        return port;
    }
    throw createError({ code: errorCodes.envelopeInvalid, message, retryable: false });
}

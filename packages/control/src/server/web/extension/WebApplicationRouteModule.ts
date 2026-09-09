import {
    createError,
    errorCodes,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition,
    type WebApplicationDescriptor
} from "@portable-devshell/shared";

import { routeModule } from "../../../route/ControlRouteFactory.js";

export interface WebApplicationCatalogPort {
    list(): readonly WebApplicationDescriptor[];
}

export function createWebApplicationRouteModule(
    port: WebApplicationCatalogPort
): PrefixRouteModuleDefinition {
    return routeModule("web", {
        applications: (_request, context) => {
            requireWeb(context);
            return [...port.list()] as unknown as JsonValue;
        }
    });
}

function requireWeb(context: PrefixRouteContext): void {
    if (context.peer === "web") return;
    throw createError({
        code: errorCodes.controlWebAccessDenied,
        message: "Web application discovery is available only to Web clients.",
        retryable: false
    });
}

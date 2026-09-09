import {
    createError,
    errorCodes,
    type CliCommandDescriptor,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface CliCommandCatalogPort {
    list(): readonly CliCommandDescriptor[];
}

export function createCliRouteModule(port: CliCommandCatalogPort): PrefixRouteModuleDefinition {
    return routeModule("cli", {
        commands: (_request, context) => {
            requireCli(context);
            return [...port.list()] as unknown as JsonValue;
        }
    });
}

function requireCli(context: PrefixRouteContext): void {
    if (context.peer === "cli") return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message: "CLI command discovery is available only to CLI clients.",
        retryable: false
    });
}

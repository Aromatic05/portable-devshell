import type { JsonValue, PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../common/RouteModule.js";

export interface ConfigEditorPort {
    applyConfig(): JsonValue | Promise<JsonValue>;
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
    getConfigView(): JsonValue;
    updateInstanceConfig(params?: JsonValue): Promise<JsonValue>;
    updateMcpConfig(params?: JsonValue): Promise<JsonValue>;
    validateConfigDraft(params?: JsonValue): JsonValue;
}

export function createConfigModule(service?: ConfigEditorPort): PrefixRouteModuleDefinition {
    const config = () => requirePort(service, "Config editing is not available.");
    return routeModule("config", {
        get: () => config().getConfigView(),
        validate: (request) => config().validateConfigDraft(request.payload),
        updateInstance: async (request) => await config().updateInstanceConfig(request.payload),
        updateMcp: async (request) => await config().updateMcpConfig(request.payload),
        apply: async () => await config().applyConfig()
    });
}

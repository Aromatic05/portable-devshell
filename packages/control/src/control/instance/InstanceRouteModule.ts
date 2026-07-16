import type {
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    InstanceListEntry,
    JsonValue,
    PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { requirePort, routeModule } from "../../route/ControlRouteFactory.js";
import type { InstanceRegistry } from "./registry/InstanceRegistry.js";

export interface InstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface InstanceEditorPort {
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
}

export interface InstanceRouteModuleOptions {
    create?: InstanceCreatePort;
    editor?: InstanceEditorPort;
    registry: InstanceRegistry;
}

export function createInstanceRouteModule(options: InstanceRouteModuleOptions): PrefixRouteModuleDefinition {
    const create = () => requirePort(options.create, "Instance creation is not available.");
    const editor = () => requirePort(options.editor, "Config editing is not available.");
    return routeModule("instance", {
        list: () => options.registry.list().map((descriptor): InstanceListEntry => ({
            mcpEnabled: descriptor.mcpEnabled,
            name: descriptor.name,
            snapshot: descriptor.worker.snapshot()
        })) as never,
        createSchema: () => create().getSchema() as never,
        validateCreate: (request) => create().validateDraft(request.payload) as never,
        create: async (request) => await create().createInstance(request.payload) as never,
        enable: async (request) => await editor().enableInstance(request.payload),
        disable: async (request) => await editor().disableInstance(request.payload),
        delete: async (request) => await editor().deleteInstance(request.payload)
    });
}

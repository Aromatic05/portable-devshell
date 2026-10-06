import type {
    InstanceRegistry,
} from "@portable-devshell/core";
import type {
    ControlConfig,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
} from "@portable-devshell/shared";

import type { InstanceChangeHub } from "./Change.js";

export interface InstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface InstanceEditorPort {
    deleteInstance(params?: JsonValue): Promise<JsonValue>;
    disableInstance(params?: JsonValue): Promise<JsonValue>;
    enableInstance(params?: JsonValue): Promise<JsonValue>;
    updateInstanceConfig(params?: JsonValue): Promise<JsonValue>;
}

export interface InstanceConfigRouteModuleOptions {
    changes: InstanceChangeHub;
    configuredInstances?: () => readonly ControlConfig["instances"][number][];
    create?: InstanceCreatePort;
    editor?: InstanceEditorPort;
    registry: InstanceRegistry;
}

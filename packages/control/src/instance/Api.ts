import type { InstanceRegistry } from "./Registry.js";
export type { InstanceRegistry } from "./Registry.js";
import type {
    ControlConfig,
    InstanceCreateResult,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
} from "@portable-devshell/shared";

import type { InstanceChangeHub } from "./Change.js";
export type { InstanceChangeHub } from "./Change.js";
export type { ReverseCredentials } from "./reverse/Credentials.js";
export type { InstanceMcpRuntimePort } from "./Mcp.js";
import type { InstanceCreateCoordinator } from "./editor/create/index.js";
import type { InstanceEditorCoordinator } from "./editor/index.js";
export type { InstanceCreateCoordinator, InstanceEditorCoordinator };

export interface InstanceCreatePort {
    createInstance(params?: JsonValue): Promise<InstanceCreateResult>;
    getSchema(): InstanceCreateSchema;
    validateDraft(params?: JsonValue): InstanceCreateSummary;
}

export interface InstanceEditorPort {
    listCleanupDebts(): Promise<Array<Record<string, string>>>;
    reconcileCleanupDebt(instance?: string): Promise<void>;
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

import type { ToolCallRegistry } from "./Api.js";
import { ToolCallRegistryState } from "./Registry.js";

export { installInstanceToolDefinitions } from "./Registry.js";
export type {
    InstallInstanceToolDefinitionsOptions,
} from "./Registry.js";
export type { InstanceToolCatalogSource } from "./Api.js";

export function createToolCallRegistry(): ToolCallRegistry {
    return new ToolCallRegistryState();
}

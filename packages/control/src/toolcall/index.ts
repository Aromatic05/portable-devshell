import type { ToolCallRegistry } from "./Api.js";
import { ToolCallRegistryState } from "./Registry.js";

export { installInstanceToolDefinitions } from "./Registry.js";
export type {
    InstallInstanceToolDefinitionsOptions,
    InstanceToolCatalogSource,
} from "./Registry.js";

export function createToolCallRegistry(): ToolCallRegistry {
    return new ToolCallRegistryState();
}

import type { ToolCallRegistry } from "./Api.js";
import { ToolCallRegistryState } from "./Registry.js";

export function createToolCallRegistry(): ToolCallRegistry {
    return new ToolCallRegistryState();
}

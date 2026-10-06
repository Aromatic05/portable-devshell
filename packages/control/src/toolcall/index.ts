import type { ToolCallRegistry } from "./Api.js";
import {
    allToolCallInstances,
    ToolCallRegistryState,
} from "./Registry.js";

export { allToolCallInstances };

export function createToolCallRegistry(): ToolCallRegistry {
    return new ToolCallRegistryState();
}

import type { McpEndpointBinding } from "../../endpoint/McpEndpointBinding.js";

export class McpHostRouteRegistry {
    readonly #bindings = new Map<string, { binding: McpEndpointBinding; path: string }>();

    register(entry: { binding: McpEndpointBinding; path: string }): void {
        this.#bindings.set(entry.binding.instanceName, entry);
    }

    resolve(instanceName: string): McpEndpointBinding | undefined {
        return this.#bindings.get(instanceName)?.binding;
    }

    list(): Array<{ binding: McpEndpointBinding; path: string }> {
        return [...this.#bindings.values()];
    }
}

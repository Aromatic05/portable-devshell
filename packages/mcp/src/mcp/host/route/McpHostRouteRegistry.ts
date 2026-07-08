import type { McpEndpointBinding } from "../../endpoint/McpEndpointBinding.js";

export class McpHostRouteRegistry {
    readonly #bindings = new Map<string, McpEndpointBinding>();

    register(binding: McpEndpointBinding): void {
        this.#bindings.set(binding.instanceName, binding);
    }

    resolve(instanceName: string): McpEndpointBinding | undefined {
        return this.#bindings.get(instanceName);
    }

    list(): McpEndpointBinding[] {
        return [...this.#bindings.values()];
    }
}

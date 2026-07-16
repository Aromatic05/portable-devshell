import type { McpEndpointBinding } from "../../endpoint/McpEndpointBinding.js";

export interface McpHostRouteEntry {
    binding: McpEndpointBinding;
    path: string;
}

export class McpHostRouteRegistry {
    readonly #bindings = new Map<string, McpHostRouteEntry>();

    register(entry: McpHostRouteEntry): McpHostRouteEntry | undefined {
        const instanceName = entry.binding.instanceName;
        const previous = this.#bindings.get(instanceName);
        this.#bindings.set(instanceName, entry);
        return previous;
    }

    unregister(instanceName: string): McpHostRouteEntry | undefined {
        const previous = this.#bindings.get(instanceName);
        this.#bindings.delete(instanceName);
        return previous;
    }

    resolve(instanceName: string): McpEndpointBinding | undefined {
        return this.#bindings.get(instanceName)?.binding;
    }

    list(): McpHostRouteEntry[] {
        return [...this.#bindings.values()];
    }
}

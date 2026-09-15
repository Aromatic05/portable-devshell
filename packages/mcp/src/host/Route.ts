import type { McpEndpointBinding } from "../endpoint/Binding.js";
import type { McpAuthConfig } from "../auth/Config.js";

export interface McpHostRouteMatch {
    instanceName: string;
}

export class McpHostRouteMatcher {
    match(pathname: string): McpHostRouteMatch | undefined {
        const trimmed = pathname.trim();
        const segments = trimmed.split("/");

        if (
            segments.length !== 3 ||
            segments[0] !== "" ||
            segments[2] !== "mcp"
        ) {
            return undefined;
        }

        const instanceName = segments[1];

        if (instanceName.length === 0) {
            return undefined;
        }

        return { instanceName };
    }
}

export interface McpHostRouteEntry {
    auth?: McpAuthConfig;
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

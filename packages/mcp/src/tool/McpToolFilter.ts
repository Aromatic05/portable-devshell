import type { ToolDefinition, ToolPolicy } from "@portable-devshell/shared";

export class McpToolFilter {
    readonly #capabilities: ReadonlySet<string>;
    readonly #groups: ReadonlySet<string>;

    constructor(policy: ToolPolicy) {
        this.#capabilities = new Set(policy.capabilities);
        this.#groups = new Set(policy.groups);
    }

    isAllowed(tool: ToolDefinition): boolean {
        return (
            this.#groups.has(tool.group) &&
            tool.requiredCapabilities.every((capability) => this.#capabilities.has(capability))
        );
    }

    filter(tools: readonly ToolDefinition[]): ToolDefinition[] {
        return tools.filter((tool) => this.isAllowed(tool));
    }
}

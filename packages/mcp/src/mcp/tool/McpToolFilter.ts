import type { ToolDefinition, ToolPolicy } from "@portable-devshell/shared";

export class McpToolFilter {
    readonly #capabilities: ReadonlySet<string>;
    readonly #groups: ReadonlySet<string>;

    constructor(policy: ToolPolicy) {
        this.#capabilities = new Set(policy.capabilities);
        this.#groups = new Set(policy.groups);
    }

    filter(tools: readonly ToolDefinition[]): ToolDefinition[] {
        return tools.filter((tool) => this.#groups.has(tool.group) && this.#capabilities.has(tool.access));
    }
}

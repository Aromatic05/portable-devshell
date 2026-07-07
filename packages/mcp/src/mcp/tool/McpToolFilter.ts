interface ToolDefinition {
    name: string;
}

export class McpToolFilter {
    readonly #allowlist: ReadonlySet<string>;

    constructor(allowlist: readonly string[]) {
        this.#allowlist = new Set(allowlist);
    }

    filter(tools: readonly ToolDefinition[]): ToolDefinition[] {
        if (this.#allowlist.size === 0) {
            return [...tools];
        }

        return tools.filter((tool) => this.#allowlist.has(tool.name));
    }
}

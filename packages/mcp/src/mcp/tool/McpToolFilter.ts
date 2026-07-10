import type { ToolDefinition } from "@portable-devshell/shared";

export class McpToolFilter {
    readonly #allowlist: ReadonlySet<string>;
    readonly #allowlistEnabled: boolean;

    constructor(allowlist: readonly string[]) {
        this.#allowlist = new Set(allowlist);
        this.#allowlistEnabled = allowlist.length > 0;
    }

    filter(tools: readonly ToolDefinition[]): ToolDefinition[] {
        if (!this.#allowlistEnabled) {
            return [];
        }

        return tools.filter((tool) => this.#allowlist.has(tool.name));
    }
}

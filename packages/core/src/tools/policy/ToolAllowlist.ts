export class ToolAllowlist {
    readonly #allowedTools: ReadonlySet<string>;

    constructor(allowedTools: readonly string[]) {
        this.#allowedTools = new Set(allowedTools);
    }

    isAllowed(toolName: string): boolean {
        if (this.#allowedTools.size === 0) {
            return true;
        }

        return this.#allowedTools.has(toolName);
    }

    filter<T extends { name: string }>(tools: readonly T[]): T[] {
        return tools.filter((tool) => this.isAllowed(tool.name));
    }
}

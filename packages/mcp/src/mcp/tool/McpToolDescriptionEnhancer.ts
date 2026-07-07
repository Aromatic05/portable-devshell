export class McpToolDescriptionEnhancer {
    enhance(description: string | undefined): string {
        const base = description?.trim() ?? "";

        if (base.length === 0) {
            return "Exposed by portable-devshell MCP.";
        }

        return `${base} Exposed by portable-devshell MCP.`;
    }
}

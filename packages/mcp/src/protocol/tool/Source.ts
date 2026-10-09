import type { ToolDefinition } from "@portable-devshell/shared";

export interface McpToolSourceEntry {
    readonly definition: ToolDefinition;
    readonly scope: string;
}

export interface McpToolSource {
    list(instance: string): readonly McpToolSourceEntry[];
    get(instance: string, toolName: string): McpToolSourceEntry | undefined;
}

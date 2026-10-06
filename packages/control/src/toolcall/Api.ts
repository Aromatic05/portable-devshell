import type {
    ToolCallHooks,
    ToolCallRegistration,
    ToolDefinition,
} from "@portable-devshell/shared";

export interface ToolCallDefinitionEntry {
    definition: ToolDefinition;
    scope: string;
}

export interface ToolCallDefinitionRegistration {
    replace(definitions: readonly ToolDefinition[]): void;
    dispose(): void;
}

export interface ToolCallRegistry extends ToolCallRegistration {
    bind(hooks: ToolCallHooks): () => void;
    register(
        scope: string,
        definitions: readonly ToolDefinition[],
    ): ToolCallDefinitionRegistration;
    registerAll(
        definitions: readonly ToolDefinition[],
    ): ToolCallDefinitionRegistration;
    list(instance: string): readonly ToolCallDefinitionEntry[];
    get(
        instance: string,
        toolName: string,
    ): ToolCallDefinitionEntry | undefined;
}

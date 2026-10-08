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

export interface InstanceToolCatalogSource {
    readonly config: { readonly mcpEnabled: boolean; readonly name: string };
    readonly toolCallHooks: ToolCallHooks;
    readonly toolDefinitions: {
        register(definitions: readonly ToolDefinition[]): ToolCallDefinitionRegistration;
        list(): readonly ToolDefinition[];
    };
}

export interface ToolCallRegistry extends ToolCallRegistration {
    bind(options: {
        changes: { onChange(listener: () => void): () => void };
        instances: { list(): readonly InstanceToolCatalogSource[] };
    }): () => void;
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

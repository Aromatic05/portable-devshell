import type {
    ControlInstanceConfig,
} from "@portable-devshell/shared";

export interface InstanceConfig {
    readonly enabled: boolean;
    readonly mcpEnabled: boolean;
    readonly mcpPath: string;
    readonly inlineToolCalls?: boolean;
    readonly workspaceEnabled?: boolean;
    readonly modelExtensions: readonly string[];
    readonly name: string;
    readonly provider: ControlInstanceConfig["provider"];
}

export function toInstanceConfig(
    config: ControlInstanceConfig,
): InstanceConfig {
    return {
        enabled: config.enabled,
        mcpEnabled: config.mcp.enabled,
        mcpPath: config.mcp.path,
        inlineToolCalls: config.workspace.inlineToolCalls ?? false,
        workspaceEnabled: config.workspace.enabled,
        modelExtensions: [...config.extensions.model],
        name: config.name,
        provider: config.provider,
    };
}

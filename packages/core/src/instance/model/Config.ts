import type {
    ControlInstanceConfig,
    ControlMcpContextMode,
} from "@portable-devshell/shared";

export interface InstanceConfig {
    readonly enabled: boolean;
    readonly mcpContextMode?: ControlMcpContextMode;
    readonly mcpEnabled: boolean;
    readonly mcpPath: string;
    readonly modelExtensions: readonly string[];
    readonly name: string;
    readonly provider: ControlInstanceConfig["provider"];
}

export function toInstanceConfig(
    config: ControlInstanceConfig,
): InstanceConfig {
    return {
        enabled: config.enabled,
        mcpContextMode: config.mcp.contextMode,
        mcpEnabled: config.mcp.enabled,
        mcpPath: config.mcp.path,
        modelExtensions: [...config.extensions.model],
        name: config.name,
        provider: config.provider,
    };
}

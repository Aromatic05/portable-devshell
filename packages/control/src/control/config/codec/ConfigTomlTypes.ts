import type { ApprovalPolicy, InstanceContainerConfig, ToolCapability } from "@portable-devshell/shared";

export type ControlProviderKind = "docker" | "local" | "podman" | "reverse" | "ssh";
export type ControlMcpAuthMode = "none" | "oauth2" | "token";

export interface ControlInstanceLogsConfig {
    eventBufferSize?: number;
    retentionDays?: number;
}

export interface ControlToolSchedulerToolLimitConfig {
    maxRunning?: number;
    queueDepth?: number;
}

export interface ControlToolSchedulerConfig {
    maxRunning?: number;
    queueDepth?: number;
    queueTimeoutMs?: number;
    maxRunningPerSession?: number;
    queueDepthPerSession?: number;
    byTool?: Record<string, ControlToolSchedulerToolLimitConfig>;
}

export interface ControlInstanceToolsConfig {
    scheduler?: ControlToolSchedulerConfig;
}

export interface ControlInstanceMcpConfig {
    enabled: boolean;
    path?: string;
    tools: {
        capabilities: ToolCapability[];
        groups: string[];
    };
}

export interface ControlInstanceSecurityConfig {
    mode?: string;
}

export interface ControlInstanceSshConfig {
    command?: string;
}

export interface ControlInstanceConfig {
    approvalPolicy?: ApprovalPolicy;
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    enabled: boolean;
    env?: Record<string, string>;
    logs?: ControlInstanceLogsConfig;
    mcp: ControlInstanceMcpConfig;
    name: string;
    podmanBinary?: string;
    provider: ControlProviderKind;
    security?: ControlInstanceSecurityConfig;
    ssh?: ControlInstanceSshConfig;
    tools?: ControlInstanceToolsConfig;
    workspace?: string;
}

export interface ControlMcpOAuth2Config {
    audience?: string;
    documentationUrl?: string;
    issuer?: string;
    jwksUri?: string;
    requiredScopes: string[];
    resourceName: string;
}

export interface ControlGlobalConfig {
    control: {
        logLevel: string;
    };
    mcp: {
        auth: {
            mode: ControlMcpAuthMode;
            oauth2?: ControlMcpOAuth2Config;
        };
        enabled: boolean;
        listenHost: string;
        listenPort: number;
        publicBaseUrl?: string;
    };
    version: number;
}

export interface ControlConfig extends ControlGlobalConfig {
    instances: ControlInstanceConfig[];
}

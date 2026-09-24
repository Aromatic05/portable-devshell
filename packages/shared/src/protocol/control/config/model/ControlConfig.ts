import type { ApprovalPolicy } from "../../../tool/Approval.js";
import type { InstanceContainerConfig } from "../../../instance/Create.js";

export type ControlProviderKind =
    "docker" | "local" | "podman" | "reverse" | "ssh";
export type ControlMcpAuthMode = "none" | "oauth2" | "token";
export type ControlMcpContextMode = "explicit" | "openai-session";
export type ControlMcpOAuth2ApprovalMode = "token" | "tui";
export type ControlWebAuthMode = "none" | "oauth2" | "token";
export type ControlSecurityMode = "disabled" | "workspace";

export interface ControlInstanceLogsConfig {
    eventBufferSize?: number;
    maxBytes?: number;
    retentionDays?: number;
}

export interface ControlInstanceAlertScriptConfig {
    command: string[];
    id: string;
    timeoutMs?: number;
}

export interface ControlInstanceAlertsConfig {
    intervalMs?: number;
    maxUncommittedChanges?: number;
    scripts?: ControlInstanceAlertScriptConfig[];
    workerMemoryBytes?: number;
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
    auth: ControlMcpAuthConfig;
    contextMode: ControlMcpContextMode;
    enabled: boolean;
    path: string;
}

export interface ControlInstanceExtensionsConfig {
    model: string[];
}

export interface ControlInstanceWorkspaceConfig {
    enabled: boolean;
}

export interface ControlInstanceSecurityConfig {
    mode: ControlSecurityMode;
}

export interface ControlInstanceSshConfig {
    command: string;
}

interface ControlInstanceConfigBase {
    alerts?: ControlInstanceAlertsConfig;
    approvalPolicy?: ApprovalPolicy;
    enabled: boolean;
    env?: Record<string, string>;
    extensions: ControlInstanceExtensionsConfig;
    logs?: ControlInstanceLogsConfig;
    mcp: ControlInstanceMcpConfig;
    name: string;
    security: ControlInstanceSecurityConfig;
    tools?: ControlInstanceToolsConfig;
    workspace: ControlInstanceWorkspaceConfig;
}

export interface ControlLocalInstanceConfig extends ControlInstanceConfigBase {
    container?: undefined;
    dockerBinary?: undefined;
    podmanBinary?: undefined;
    provider: "local";
    ssh?: undefined;
}

export interface ControlReverseInstanceConfig extends ControlInstanceConfigBase {
    container?: undefined;
    dockerBinary?: undefined;
    podmanBinary?: undefined;
    provider: "reverse";
    ssh?: undefined;
}

export interface ControlSshInstanceConfig extends ControlInstanceConfigBase {
    container?: undefined;
    dockerBinary?: undefined;
    podmanBinary?: undefined;
    provider: "ssh";
    ssh: ControlInstanceSshConfig;
}

export interface ControlDockerInstanceConfig extends ControlInstanceConfigBase {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    podmanBinary?: undefined;
    provider: "docker";
    ssh?: undefined;
}

export interface ControlPodmanInstanceConfig extends ControlInstanceConfigBase {
    container: InstanceContainerConfig;
    dockerBinary?: undefined;
    podmanBinary?: string;
    provider: "podman";
    ssh?: undefined;
}

export type ControlInstanceConfig =
    | ControlDockerInstanceConfig
    | ControlLocalInstanceConfig
    | ControlPodmanInstanceConfig
    | ControlReverseInstanceConfig
    | ControlSshInstanceConfig;

export interface ControlMcpOAuth2Config {
    documentationUrl?: string;
    requiredScopes: string[];
    resourceName: string;
}

export type ControlMcpOAuth2ApprovalConfig =
    | { approval: "tui"; token?: undefined }
    | { approval: "token"; token?: string };

export type ControlMcpAuthConfig =
    | { mode: "none"; oauth2?: undefined }
    | { mode: "token"; oauth2?: undefined; token: string }
    | { mode: "oauth2"; oauth2: ControlMcpOAuth2Config };

export interface ControlWebOAuth2Config {
    documentationUrl?: string;
    requiredScopes: string[];
    resourceName: string;
}

export type ControlWebAuthConfig =
    | { mode: "none"; oauth2?: undefined; token?: undefined }
    | { mode: "token"; oauth2?: undefined; token: string }
    | { mode: "oauth2"; oauth2: ControlWebOAuth2Config; token?: undefined };

export interface ControlGlobalConfig {
    control: {
        artifactDirectTransfer: boolean;
        logLevel: string;
    };
    mcp: {
        enabled: boolean;
        listenHost: string;
        listenPort: number;
        oauth2: ControlMcpOAuth2ApprovalConfig;
        publicBaseUrl?: string;
    };
    web: {
        auth: ControlWebAuthConfig;
        enabled: boolean;
        listenHost: string;
        listenPort: number;
        publicBaseUrl: string;
    };
}

export interface ControlConfig extends ControlGlobalConfig {
    instances: ControlInstanceConfig[];
}

export type Config = ControlConfig;
export type ConfigGlobal = ControlGlobalConfig;
export type ConfigInstance = ControlInstanceConfig;

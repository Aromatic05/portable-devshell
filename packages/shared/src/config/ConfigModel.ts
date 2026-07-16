import type { ApprovalPolicy } from "../dto/tool/DtoToolApproval.js";
import type { ToolCapability } from "../dto/tool/DtoToolDefinition.js";
import type {
    InstanceContainerConfig,
    InstanceContainerMode,
    InstanceContainerMountConfig
} from "../dto/instance/DtoInstanceCreate.js";

export type RawConfig = unknown;

export type ControlProviderKind = "docker" | "local" | "podman" | "reverse" | "ssh";
export type ControlMcpAuthMode = "none" | "oauth2" | "token";
export type ControlSecurityMode = "disabled" | "workspace";

export interface ControlInstanceLogsConfig {
    eventBufferSize?: number;
    maxBytes?: number;
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
    path: string;
    tools: {
        capabilities: ToolCapability[];
        groups: string[];
    };
}

export interface ControlInstanceSecurityConfig {
    mode: ControlSecurityMode;
}

export interface ControlInstanceSshConfig {
    command: string;
}

interface ControlInstanceConfigBase {
    approvalPolicy?: ApprovalPolicy;
    enabled: boolean;
    env?: Record<string, string>;
    logs?: ControlInstanceLogsConfig;
    mcp: ControlInstanceMcpConfig;
    name: string;
    security: ControlInstanceSecurityConfig;
    tools?: ControlInstanceToolsConfig;
    workspace: string;
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
    audience?: string;
    documentationUrl?: string;
    issuer?: string;
    jwksUri?: string;
    requiredScopes: string[];
    resourceName: string;
}

export type ControlMcpAuthConfig =
    | { mode: "none"; oauth2?: undefined }
    | { mode: "token"; oauth2?: undefined }
    | { mode: "oauth2"; oauth2: ControlMcpOAuth2Config };

export interface ControlGlobalConfig {
    control: {
        logLevel: string;
    };
    mcp: {
        auth: ControlMcpAuthConfig;
        enabled: boolean;
        listenHost: string;
        listenPort: number;
        publicBaseUrl?: string;
    };
}

export interface ControlConfig extends ControlGlobalConfig {
    instances: ControlInstanceConfig[];
}

export type Config = ControlConfig;
export type ConfigGlobal = ControlGlobalConfig;
export type ConfigInstance = ControlInstanceConfig;

interface ConfigManagedContainerDraft {
    containerName?: string;
    env?: Record<string, string>;
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}

export type ConfigContainerDraft =
    | (ConfigManagedContainerDraft & {
          image?: string;
          mode: "preset";
          preset: string;
      })
    | (ConfigManagedContainerDraft & {
          build: {
              context: string;
              dockerfile?: string;
              tag?: string;
          };
          mode: "dockerfile";
      })
    | {
          compose: {
              file: string;
              projectName?: string;
              service: string;
          };
          mode: "compose";
      }
    | (ConfigManagedContainerDraft & {
          image: string;
          mode: "existingImage";
      })
    | {
          adoptLifecycle?: boolean;
          containerName: string;
          mode: "existingStoppedContainer";
      };

export interface ConfigInstanceMcpDraft {
    enabled?: boolean;
    path?: string;
    tools?: {
        capabilities?: ToolCapability[];
        groups?: string[];
    };
}

export interface ConfigInstanceDraft {
    approvalPolicy?: ApprovalPolicy;
    container?: ConfigContainerDraft;
    dockerBinary?: string;
    enabled?: boolean;
    env?: Record<string, string>;
    logs?: ControlInstanceLogsConfig;
    mcp?: ConfigInstanceMcpDraft;
    name: string;
    podmanBinary?: string;
    provider: ControlProviderKind;
    security?: {
        mode?: ControlSecurityMode;
    };
    ssh?: {
        command?: string;
    };
    tools?: ControlInstanceToolsConfig;
    workspace?: string;
}

export interface ConfigMcpOAuth2Draft {
    audience?: string;
    documentationUrl?: string;
    issuer?: string;
    jwksUri?: string;
    requiredScopes?: string[];
    resourceName: string;
}

export type ConfigMcpAuthDraft =
    | { mode: "none" }
    | { mode: "token" }
    | { mode: "oauth2"; oauth2: ConfigMcpOAuth2Draft };

export interface ConfigGlobalDraft {
    control?: {
        logLevel?: string;
    };
    mcp?: {
        auth?: ConfigMcpAuthDraft;
        enabled?: boolean;
        listenHost?: string;
        listenPort?: number;
        publicBaseUrl?: string | null;
    };
}

export interface ConfigDraft extends ConfigGlobalDraft {
    instances?: ConfigInstanceDraft[];
}

export type ConfigNullable<T> = T | null;

export interface ConfigInstancePatch {
    approvalPolicy?: ConfigNullable<ApprovalPolicy>;
    container?: ConfigNullable<ConfigContainerDraft>;
    dockerBinary?: ConfigNullable<string>;
    enabled?: boolean;
    env?: ConfigNullable<Record<string, string>>;
    logs?: ConfigNullable<ControlInstanceLogsConfig>;
    mcp?: {
        enabled?: boolean;
        path?: ConfigNullable<string>;
        tools?: {
            capabilities?: ToolCapability[];
            groups?: string[];
        };
    };
    podmanBinary?: ConfigNullable<string>;
    provider?: ControlProviderKind;
    security?: {
        mode?: ControlSecurityMode;
    };
    ssh?: ConfigNullable<{
        command?: string;
    }>;
    tools?: ConfigNullable<ControlInstanceToolsConfig>;
    workspace?: string;
}

export interface ConfigMcpPatch {
    auth?: ConfigMcpAuthDraft;
    enabled?: boolean;
    listenHost?: string;
    listenPort?: number;
    publicBaseUrl?: ConfigNullable<string>;
}

export interface ConfigPatch {
    control?: {
        logLevel?: string;
    };
    mcp?: ConfigMcpPatch;
}

export interface ConfigUpdateInstanceRequest {
    instanceName: string;
    patch: ConfigInstancePatch;
}

export interface ConfigUpdateMcpRequest {
    patch: ConfigMcpPatch;
}

export interface ConfigInstanceTargetRequest {
    instanceName: string;
}

export type ConfigInstanceView = ControlInstanceConfig extends infer T
    ? T extends ControlInstanceConfig
        ? Omit<T, "security"> & {
              security: {
                  effectiveMode: ControlSecurityMode;
                  mode: ControlSecurityMode;
              };
          }
        : never
    : never;

export interface ConfigView {
    control: ControlGlobalConfig["control"];
    instances: ConfigInstanceView[];
    mcp: ControlGlobalConfig["mcp"];
}

export interface ConfigPresetDefinition {
    image: string;
    preset: string;
}

export interface ConfigNormalizeContext {
    containerPresets: readonly ConfigPresetDefinition[];
    defaultEnabled: boolean;
    defaultMcpCapabilities: readonly ToolCapability[];
    defaultMcpEnabled: boolean;
    defaultMcpGroups: readonly string[];
    defaultSecurityMode: ControlSecurityMode;
}

export const defaultConfigNormalizeContext: ConfigNormalizeContext = {
    containerPresets: [
        { image: "archlinux:latest", preset: "arch" },
        { image: "ubuntu:24.04", preset: "ubuntu" },
        { image: "debian:stable", preset: "debian" },
        { image: "alpine:latest", preset: "alpine" }
    ],
    defaultEnabled: true,
    defaultMcpCapabilities: ["read", "write", "execute"],
    defaultMcpEnabled: true,
    defaultMcpGroups: ["file", "bash", "artifact", "tmux", "todo"],
    defaultSecurityMode: "disabled"
};

export const minimumAuditStorageBytes = 1024 * 1024;

export type ConfigContainerMode = InstanceContainerMode;

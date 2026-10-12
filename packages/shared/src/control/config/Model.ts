import type { JsonValue } from "../../types/Json.js";
import { type ApprovalPolicy } from "./Policy.js";

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
export interface ControlInstanceConfigBase {
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
interface ControlNonContainerInstanceConfig {
    container?: undefined;
    dockerBinary?: undefined;
    podmanBinary?: undefined;
}
interface ControlNonSshInstanceConfig {
    ssh?: undefined;
}
export interface ControlLocalInstanceConfig
    extends
        ControlInstanceConfigBase,
        ControlNonContainerInstanceConfig,
        ControlNonSshInstanceConfig {
    provider: "local";
}
export interface ControlReverseInstanceConfig
    extends
        ControlInstanceConfigBase,
        ControlNonContainerInstanceConfig,
        ControlNonSshInstanceConfig {
    provider: "reverse";
}
export interface ControlSshInstanceConfig
    extends ControlInstanceConfigBase, ControlNonContainerInstanceConfig {
    provider: "ssh";
    ssh: ControlInstanceSshConfig;
}
export interface ControlDockerInstanceConfig
    extends ControlInstanceConfigBase, ControlNonSshInstanceConfig {
    container: InstanceContainerConfig;
    dockerBinary?: string;
    podmanBinary?: undefined;
    provider: "docker";
}
export interface ControlPodmanInstanceConfig
    extends ControlInstanceConfigBase, ControlNonSshInstanceConfig {
    container: InstanceContainerConfig;
    dockerBinary?: undefined;
    podmanBinary?: string;
    provider: "podman";
}
export type ControlInstanceConfig =
    | ControlDockerInstanceConfig
    | ControlLocalInstanceConfig
    | ControlPodmanInstanceConfig
    | ControlReverseInstanceConfig
    | ControlSshInstanceConfig;
export interface ControlOAuth2Config {
    documentationUrl?: string;
    requiredScopes: string[];
    resourceName: string;
}
export type ControlWebOAuth2Config = ControlOAuth2Config;
export type ControlMcpOAuth2ApprovalConfig =
    | { approval: "tui"; token?: undefined }
    | { approval: "token"; token?: string };
export type ControlMcpAuthConfig =
    | { mode: "none"; oauth2?: undefined }
    | { mode: "token"; oauth2?: undefined; token: string }
    | { mode: "oauth2"; oauth2: ControlOAuth2Config };
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
export interface ConfigPresetDefinition {
    image: string;
    preset: string;
}
export interface ConfigNormalizeContext {
    containerPresets: readonly ConfigPresetDefinition[];
    defaultEnabled: boolean;
    defaultMcpEnabled: boolean;
    defaultModelExtensions: readonly string[];
    defaultSecurityMode: ControlSecurityMode;
}
export const defaultConfigNormalizeContext: ConfigNormalizeContext = {
    containerPresets: [
        { image: "archlinux:latest", preset: "arch" },
        { image: "ubuntu:24.04", preset: "ubuntu" },
        { image: "debian:stable", preset: "debian" },
        { image: "alpine:latest", preset: "alpine" },
    ],
    defaultEnabled: true,
    defaultMcpEnabled: true,
    defaultModelExtensions: ["artifact", "comment", "instance", "mcp", "secret", "skill"],
    defaultSecurityMode: "disabled",
};
export const MASKED_CONFIG_TOKEN = "********";
export const minimumAuditStorageBytes = 1024 * 1024;
// Container configuration vocabulary shared by Control config editing and
// instance creation. This is Control-owned because container settings are part
// of the control-plane instance definition, not worker runtime state.

export type InstanceContainerMode =
    | "preset"
    | "dockerfile"
    | "compose"
    | "existingImage"
    | "existingStoppedContainer";
export type InstanceContainerMountMode = "ro" | "rw";
export type InstanceContainerMountSelinuxMode = "private" | "shared";
export interface InstanceContainerMountConfig {
    mode: InstanceContainerMountMode;
    selinux?: InstanceContainerMountSelinuxMode;
    source: string;
    target: string;
}
export interface InstanceContainerPresetSchema {
    image: string;
    preset: string;
}
export interface InstanceContainerPresetConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "preset";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    preset: string;
    user?: string;
}
export interface InstanceContainerDockerfileConfig {
    build: {
        context: string;
        dockerfile?: string;
        tag?: string;
    };
    containerName: string;
    env?: Record<string, string>;
    mode: "dockerfile";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}
export interface InstanceContainerComposeConfig {
    compose: {
        file: string;
        projectName?: string;
        service: string;
    };
    mode: "compose";
}
export interface InstanceContainerExistingImageConfig {
    containerName: string;
    env?: Record<string, string>;
    image: string;
    mode: "existingImage";
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}
export interface InstanceContainerExistingStoppedContainerConfig {
    adoptLifecycle?: boolean;
    containerName: string;
    mode: "existingStoppedContainer";
}
export type InstanceContainerConfig =
    | InstanceContainerPresetConfig
    | InstanceContainerDockerfileConfig
    | InstanceContainerComposeConfig
    | InstanceContainerExistingImageConfig
    | InstanceContainerExistingStoppedContainerConfig;
export interface InstanceManagedContainerDraft {
    containerName?: string;
    env?: Record<string, string>;
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
}
export type InstanceContainerDraft =
    | (InstanceManagedContainerDraft & {
          image?: string;
          mode: "preset";
          preset: string;
      })
    | (InstanceManagedContainerDraft & {
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
    | (InstanceManagedContainerDraft & {
          image: string;
          mode: "existingImage";
      })
    | {
          adoptLifecycle?: boolean;
          containerName: string;
          mode: "existingStoppedContainer";
      };

export interface ConfigInstanceMcpDraft {
    auth?: ControlMcpAuthMode;
    contextMode?: ControlMcpContextMode;
    enabled?: boolean;
    oauth2?: ConfigOAuth2Draft;
    path?: string;
    token?: string;
}

export interface ConfigInstanceDraft {
    alerts?: ControlInstanceAlertsConfig;
    approvalPolicy?: ApprovalPolicy;
    container?: InstanceContainerDraft;
    dockerBinary?: string;
    enabled?: boolean;
    env?: Record<string, string>;
    extensions?: {
        model?: string[];
    };
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
    workspace?: {
        enabled?: boolean;
    };
}

interface ConfigOAuth2Draft {
    documentationUrl?: string;
    requiredScopes?: string[];
    resourceName: string;
}
export type ConfigWebOAuth2Draft = ConfigOAuth2Draft;

export interface ConfigGlobalMcpOAuth2Draft {
    approval?: ControlMcpOAuth2ApprovalMode;
    token?: string;
}

export type ConfigMcpAuthDraft =
    | { mode: "none" }
    | { mode: "token"; token: string }
    | { mode: "oauth2"; oauth2: ConfigOAuth2Draft };

export interface ConfigGlobalDraft {
    control?: {
        artifactDirectTransfer?: boolean;
        logLevel?: string;
    };
    mcp?: {
        enabled?: boolean;
        listenHost?: string;
        listenPort?: number;
        oauth2?: ConfigGlobalMcpOAuth2Draft;
        publicBaseUrl?: string | null;
    };
    web?: {
        auth?: ControlWebAuthMode;
        enabled?: boolean;
        listenHost?: string;
        listenPort?: number;
        oauth2?: ConfigWebOAuth2Draft;
        publicBaseUrl?: string | null;
        token?: string;
    };
}

export interface ConfigDraft extends ConfigGlobalDraft {
    instances?: ConfigInstanceDraft[];
}

type ConfigNullable<T> = T | null;

export interface ConfigInstancePatch {
    alerts?: ConfigNullable<ControlInstanceAlertsConfig>;
    approvalPolicy?: ConfigNullable<ApprovalPolicy>;
    container?: ConfigNullable<InstanceContainerDraft>;
    dockerBinary?: ConfigNullable<string>;
    enabled?: boolean;
    env?: ConfigNullable<Record<string, string>>;
    extensions?: {
        model?: string[];
    };
    logs?: ConfigNullable<ControlInstanceLogsConfig>;
    mcp?: {
        auth?: ControlMcpAuthMode;
        contextMode?: ControlMcpContextMode;
        enabled?: boolean;
        oauth2?: ConfigOAuth2Draft;
        path?: ConfigNullable<string>;
        token?: string;
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
    workspace?: {
        enabled?: boolean;
    };
}

export interface ConfigMcpPatch {
    enabled?: boolean;
    listenHost?: string;
    listenPort?: number;
    oauth2?: ConfigGlobalMcpOAuth2Draft;
    publicBaseUrl?: ConfigNullable<string>;
}

export interface ConfigWebPatch {
    auth?: ControlWebAuthMode;
    enabled?: boolean;
    listenHost?: string;
    listenPort?: number;
    oauth2?: ConfigWebOAuth2Draft;
    publicBaseUrl?: ConfigNullable<string>;
    token?: string;
}

export interface ConfigUpdateInstanceRequest {
    instanceName: string;
    patch: ConfigInstancePatch;
}

export interface ConfigUpdateMcpRequest {
    patch: ConfigMcpPatch;
}

export interface ConfigUpdateWebRequest {
    patch: ConfigWebPatch;
}

export interface ConfigBatchUpdateRequest {
    instance?: ConfigUpdateInstanceRequest;
    mcp?: ConfigMcpPatch;
    web?: ConfigWebPatch;
}

const configInstanceRestartPaths = [
    "provider",
    "ssh",
    "container",
    "dockerBinary",
    "podmanBinary",
    "logs",
    "tools",
] as const;

export function configInstanceRequiresRestart(
    previous: Readonly<Record<string, JsonValue>>,
    next: Readonly<Record<string, JsonValue>>,
): boolean {
    return configInstanceRestartPaths.some(
        (path) => JSON.stringify(previous[path]) !== JSON.stringify(next[path]),
    );
}

export function configInstanceChangedPaths(
    previous: Readonly<Record<string, JsonValue>>,
    next: Readonly<Record<string, JsonValue>>,
    prefix = "",
): string[] {
    const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    return [...keys].sort().flatMap((key) => {
        const path = prefix.length === 0 ? key : `${prefix}.${key}`;
        const before = previous[key];
        const after = next[key];
        if (isJsonRecord(before) && isJsonRecord(after)) {
            return configInstanceChangedPaths(before, after, path);
        }
        return JSON.stringify(before) === JSON.stringify(after) ? [] : [path];
    });
}

function isJsonRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
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
    restartControlRequired: boolean;
    web: ConfigWebView;
}

export interface ConfigWebView {
    auth: ControlWebAuthMode;
    enabled: boolean;
    listenHost: string;
    listenPort: number;
    oauth2?: ControlWebOAuth2Config;
    publicBaseUrl: string;
    token?: string;
}

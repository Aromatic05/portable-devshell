import type { ApprovalPolicy } from "../../../tool/Approval.js";
import type { InstanceContainerMountConfig } from "../../../instance/Create.js";
import type {
    ControlConfig,
    ControlGlobalConfig,
    ControlInstanceAlertsConfig,
    ControlInstanceConfig,
    ControlInstanceLogsConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthMode,
    ControlMcpContextMode,
    ControlProviderKind,
    ControlSecurityMode,
    ControlWebAuthMode,
    ControlWebOAuth2Config,
} from "./ControlConfig.js";

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
    auth?: ControlMcpAuthMode;
    contextMode?: ControlMcpContextMode;
    enabled?: boolean;
    oauth2?: ConfigMcpOAuth2Draft;
    path?: string;
    token?: string;
}

export interface ConfigInstanceDraft {
    alerts?: ControlInstanceAlertsConfig;
    approvalPolicy?: ApprovalPolicy;
    container?: ConfigContainerDraft;
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

export interface ConfigMcpOAuth2Draft {
    documentationUrl?: string;
    requiredScopes?: string[];
    resourceName: string;
}

export interface ConfigWebOAuth2Draft {
    documentationUrl?: string;
    requiredScopes?: string[];
    resourceName: string;
}

export type ConfigMcpAuthDraft =
    | { mode: "none" }
    | { mode: "token"; token: string }
    | { mode: "oauth2"; oauth2: ConfigMcpOAuth2Draft };

export interface ConfigGlobalDraft {
    control?: {
        artifactDirectTransfer?: boolean;
        logLevel?: string;
    };
    mcp?: {
        enabled?: boolean;
        listenHost?: string;
        listenPort?: number;
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

export type ConfigNullable<T> = T | null;

export interface ConfigInstancePatch {
    alerts?: ConfigNullable<ControlInstanceAlertsConfig>;
    approvalPolicy?: ConfigNullable<ApprovalPolicy>;
    container?: ConfigNullable<ConfigContainerDraft>;
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
        oauth2?: ConfigMcpOAuth2Draft;
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

export interface ConfigPatch {
    control?: {
        artifactDirectTransfer?: boolean;
        logLevel?: string;
    };
    mcp?: ConfigMcpPatch;
    web?: ConfigWebPatch;
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

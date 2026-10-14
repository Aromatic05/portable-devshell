import type {
    InstanceListEntry,
    InstanceSnapshot,
} from "../../execution/process/Model.js";
import type { ApprovalPolicy } from "../config/Policy.js";
import type {
    ControlInstanceAlertsConfig,
    ControlInstanceConfigBase,
    ControlExecutionConfig,
    ControlInstanceLogsConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthMode,
    ControlMcpContextMode,
    ControlOAuth2Config,
    ControlProviderKind,
    ControlSecurityMode,
    InstanceContainerConfig,
    InstanceContainerDraft,
    InstanceContainerMode,
    InstanceContainerPresetSchema,
} from "../config/Model.js";

export type InstanceCreateProvider = ControlProviderKind;
export interface InstanceCreateSchema {
    container: {
        defaultMode: InstanceContainerMode;
        modes: readonly [
            "preset",
            "dockerfile",
            "compose",
            "existingImage",
            "existingStoppedContainer",
        ];
        presets: readonly InstanceContainerPresetSchema[];
    };
    providers: readonly InstanceCreateProvider[];
    defaultProvider: InstanceCreateProvider;
    defaultEnabled: boolean;
    defaultMcpContextMode?: ControlMcpContextMode;
    defaultMcpEnabled: boolean;
    defaultModelExtensions: readonly string[];
    defaultSecurityMode: ControlSecurityMode;
    sshHosts?: readonly string[];
}
export interface InstanceMcpDraft {
    auth?: ControlMcpAuthMode;
    contextMode?: ControlMcpContextMode;
    enabled?: boolean;
    oauth2?: InstanceMcpOAuth2Draft;
    path?: string;
    token?: string;
}
export interface InstanceMcpOAuth2Draft {
    documentationUrl?: string;
    requiredScopes?: string[];
    resourceName: string;
}
export interface InstanceCreateDraft {
    alerts?: ControlInstanceAlertsConfig;
    approvalPolicy?: ApprovalPolicy;
    container?: InstanceContainerDraft;
    dockerBinary?: string;
    enabled?: boolean;
    env?: Record<string, string>;
    execution?: ControlExecutionConfig;
    extensions?: {
        model?: string[];
    };
    logs?: ControlInstanceLogsConfig;
    mcp?: InstanceMcpDraft;
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
export interface InstanceCreateSummary extends Omit<
    ControlInstanceConfigBase,
    "mcp" | "security" | "workspace"
> {
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    mcp: {
        auth: {
            mode: ControlMcpAuthMode;
            oauth2?: ControlOAuth2Config;
        };
        contextMode?: ControlMcpContextMode;
        enabled: boolean;
        path: string;
    };
    name: string;
    podmanBinary?: string;
    provider: InstanceCreateProvider;
    security: {
        mode: ControlSecurityMode;
    };
    ssh?: {
        command?: string;
    };
}
export interface InstanceCreateResult {
    enabled: boolean;
    mcpPath?: string;
    name: string;
    snapshot?: InstanceSnapshot;
}
// The authoritative instance list is revision-bearing: `revision` labels the
// exact list snapshot, so a subscriber can resume the change feed at
// `revision + 1` without missing or double-applying a change.
export interface InstanceListEnvelope {
    instances: InstanceListEntry[];
    revision: number;
}
export type InstanceChangeKind = "config" | "registry";
// A change feed event is only a signal: the payload carries the revision and
// its origin, and consumers coalesce an authoritative list re-read from it.
export interface InstanceChangeEvent {
    kind: InstanceChangeKind;
    revision: number;
}

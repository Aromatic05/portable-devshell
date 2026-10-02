// Instance creation model. A create draft is an instance-owned description;
// provider/security/MCP enums come from Control config because they are shared
// control-plane vocabulary. Container configuration lives in the shared
// Control-owned container vocabulary at ../container/Model.js.

import type { ApprovalPolicy } from "../../../runtime/approval/Model.js";
import type {
    InstanceListEntry,
    InstanceSnapshot,
} from "../../../runtime/state/Model.js";
import type {
    ControlInstanceAlertsConfig,
    ControlInstanceLogsConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthMode,
    ControlMcpContextMode,
    ControlMcpOAuth2Config,
    ControlProviderKind,
    ControlSecurityMode,
} from "../../config/Model.js";
import type {
    InstanceContainerConfig,
    InstanceContainerDraft,
    InstanceContainerMode,
    InstanceContainerPresetSchema,
} from "../container/Model.js";

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

export interface InstanceCreateSummary {
    approvalPolicy?: ApprovalPolicy;
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    enabled: boolean;
    env?: Record<string, string>;
    extensions: {
        model: string[];
    };
    logs?: ControlInstanceLogsConfig;
    mcp: {
        auth: {
            mode: ControlMcpAuthMode;
            oauth2?: ControlMcpOAuth2Config;
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
    tools?: ControlInstanceToolsConfig;
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

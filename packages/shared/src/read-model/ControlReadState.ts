import type { ArtifactShareResult } from "../protocol/artifact/Share.js";
import type { ArtifactTransferRecord } from "../protocol/artifact/Transfer.js";
import type { WebApplicationDescriptor } from "../protocol/control/extension/WebApplication.js";
import type { OperationalOverview } from "../protocol/control/Overview.js";
import type {
    InstanceListEntry,
    InstanceSnapshot,
} from "../protocol/instance/activity/State.js";
import type { InstanceLogEntry } from "../protocol/instance/activity/Log.js";
import type { GoalSnapshot } from "../protocol/instance/task/Goal.js";
import type { TodoReadResult } from "../protocol/instance/task/Todo.js";
import type { OAuthApprovalRequest } from "../protocol/interaction/OAuth.js";
import type { ContextMessageRecord } from "../protocol/interaction/context/ContextMessage.js";
import type { ConversationEntry } from "../protocol/interaction/context/Conversation.js";
import type { McpContextRecord } from "../protocol/interaction/context/ContextRecord.js";
import type { ApprovalRequest } from "../protocol/tool/Approval.js";
import type { ToolCallRecord } from "../protocol/tool/Call.js";
import type { JsonValue } from "../protocol/JsonValue.js";
import type {
    ControlServiceStatus,
    McpRuntimeStatus,
} from "../client/ControlClients.js";

export type ControlInstanceReadKey =
    | "snapshot"
    | "logs"
    | "approvals"
    | "goals"
    | "todo"
    | "toolCalls"
    | "comments";

export interface ControlInstanceReadState {
    approvals: ApprovalRequest[];
    commentCalls: ToolCallRecord[];
    conversationEntries: ConversationEntry[];
    contextMessages: ContextMessageRecord[];
    goals: GoalSnapshot[];
    logs: InstanceLogEntry[];
    reportCalls: ToolCallRecord[];
    sequence: number;
    snapshot?: InstanceSnapshot;
    todo?: TodoReadResult;
    toolCalls: ToolCallRecord[];
}

export type ControlGlobalReadKey =
    | "artifacts"
    | "config"
    | "contexts"
    | "instances"
    | "mcp"
    | "oauthApprovals"
    | "overview"
    | "webApplications";

export interface ControlReadFailure {
    error: Error;
    id: string;
    instance?: string;
    key: ControlGlobalReadKey | ControlInstanceReadKey | "stream";
}

export interface ControlReadModelState {
    artifactShares: ArtifactShareResult[];
    artifactTransfers: ArtifactTransferRecord[];
    configView?: Record<string, JsonValue>;
    contexts: McpContextRecord[];
    failures: Record<string, ControlReadFailure>;
    instances: InstanceListEntry[];
    instanceState: Record<string, ControlInstanceReadState>;
    mcpStatus?: McpRuntimeStatus;
    oauthApprovals: OAuthApprovalRequest[];
    overview?: OperationalOverview;
    service?: ControlServiceStatus;
    webApplications: WebApplicationDescriptor[];
}

export interface ControlReadModelLoadOptions {
    artifacts?: boolean;
    config?: boolean;
    serviceStatus?: boolean;
}

export function createInitialControlReadModelState(): ControlReadModelState {
    return {
        artifactShares: [],
        artifactTransfers: [],
        contexts: [],
        failures: {},
        instances: [],
        instanceState: {},
        oauthApprovals: [],
        webApplications: [],
    };
}

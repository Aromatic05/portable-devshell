import type { JsonValue } from "@portable-devshell/shared";

const anyValue: JsonValue = {};
const booleanValue: JsonValue = { type: "boolean" };
const nonNegativeInteger: JsonValue = { minimum: 0, type: "integer" };
const stringValue: JsonValue = { type: "string" };
const nonEmptyString: JsonValue = { minLength: 1, type: "string" };

function objectSchema(
    properties: Record<string, JsonValue>,
    required: string[] = [],
): JsonValue {
    return {
        additionalProperties: false,
        properties,
        ...(required.length === 0 ? {} : { required }),
        type: "object",
    };
}

function arraySchema(items: JsonValue): JsonValue {
    return { items, type: "array" };
}

const todoCheckpointSchema = objectSchema({
    blockers: arraySchema(stringValue),
    next: stringValue,
    summary: stringValue,
    updatedAt: stringValue,
}, ["summary", "updatedAt"]);

const todoItemSchema = objectSchema({
    content: stringValue,
    detail: stringValue,
    id: nonEmptyString,
    status: {
        enum: ["pending", "in_progress", "blocked", "completed", "failed", "cancelled"],
        type: "string",
    },
}, ["content", "id", "status"]);

const todoSummarySchema = objectSchema({
    completed: nonNegativeInteger,
    currentItemId: stringValue,
    total: nonNegativeInteger,
}, ["completed", "total"]);

const activeTodoSummaryProperties: Record<string, JsonValue> = {
    checkpoint: todoCheckpointSchema,
    completed: nonNegativeInteger,
    currentItem: stringValue,
    pausedAt: stringValue,
    revision: nonNegativeInteger,
    status: {
        enum: ["pending", "in_progress", "blocked", "completed", "failed", "cancelled", "none", "paused"],
        type: "string",
    },
    taskId: nonEmptyString,
    title: stringValue,
    total: nonNegativeInteger,
};

const activeTodoSummaryOutputSchema = objectSchema(activeTodoSummaryProperties, [
    "completed", "revision", "status", "taskId", "title", "total"
]);

export const todoTaskSummaryOutputSchema = objectSchema({
    ...activeTodoSummaryProperties,
    ctxId: nonEmptyString,
    updatedAt: stringValue,
}, ["completed", "revision", "status", "taskId", "title", "total", "updatedAt"]);

export const todoReadOutputSchema = objectSchema({
    cancelledAt: stringValue,
    checkpoint: todoCheckpointSchema,
    items: arraySchema(todoItemSchema),
    pausedAt: stringValue,
    revision: nonNegativeInteger,
    summary: todoSummarySchema,
    taskId: nonEmptyString,
    tasks: arraySchema(todoTaskSummaryOutputSchema),
    title: stringValue,
}, ["items", "revision", "summary"]);

const reverseInstanceStatusSchema = objectSchema({
    availability: { enum: ["offline", "online"], type: "string" },
    connectedAt: stringValue,
    enrollmentState: { enum: ["pending", "enrolled", "revoked"], type: "string" },
    generation: nonNegativeInteger,
    lastErrorCode: stringValue,
    lastErrorMessage: stringValue,
    lastSeenAt: stringValue,
    managementMode: { const: "selfManaged", type: "string" },
    transport: { enum: ["wss", "sse"], type: "string" },
}, ["availability", "enrollmentState", "managementMode"]);

const instanceSnapshotProperties: Record<string, JsonValue> = {
    activeTodos: arraySchema(activeTodoSummaryOutputSchema),
    connectionState: {
        enum: ["connected", "connecting", "disconnected", "reconnecting", "failed"],
        type: "string",
    },
    daemonState: {
        enum: ["running", "starting", "stopped", "stale", "stopping", "failed"],
        type: "string",
    },
    effectiveSecurityMode: { enum: ["disabled", "workspace"], type: "string" },
    lastErrorCode: stringValue,
    lastErrorMessage: stringValue,
    lastSeq: nonNegativeInteger,
    name: nonEmptyString,
    pid: nonNegativeInteger,
    ready: booleanValue,
    reverse: reverseInstanceStatusSchema,
    status: { enum: ["ready", "running", "stale", "stopped", "failed"], type: "string" },
};

export const instanceSnapshotOutputSchema = objectSchema(instanceSnapshotProperties, [
    "connectionState", "daemonState", "lastSeq", "name", "ready", "status"
]);

const instanceDescriptorSchema = objectSchema({
    enabled: booleanValue,
    mcpEnabled: booleanValue,
    name: nonEmptyString,
    provider: { enum: ["local", "ssh", "docker", "podman", "reverse"], type: "string" },
    snapshot: instanceSnapshotOutputSchema,
}, ["enabled", "mcpEnabled", "name", "snapshot"]);

export const instanceStatusOutputSchema = instanceDescriptorSchema;

export const instanceListOutputSchema = objectSchema({
    instances: arraySchema(instanceDescriptorSchema),
}, ["instances"]);

export const instanceCreateOutputSchema = objectSchema({
    enabled: booleanValue,
    mcpPath: nonEmptyString,
    name: nonEmptyString,
    snapshot: instanceSnapshotOutputSchema,
}, ["enabled", "name"]);

export const instanceConnectOutputSchema = objectSchema({
    ...instanceSnapshotProperties,
    comment: arraySchema(stringValue),
    projectMemoryAgentFile: nonEmptyString,
    projectMemoryDirectory: nonEmptyString,
    temporaryDirectory: nonEmptyString,
    workspace: nonEmptyString,
}, ["connectionState", "daemonState", "lastSeq", "name", "ready", "status"]);

export const artifactSourceOutputSchema = objectSchema({
    handle: nonEmptyString,
    instance: nonEmptyString,
    path: nonEmptyString,
    type: { enum: ["artifact", "file", "directory"], type: "string" },
    workspace: nonEmptyString,
}, ["instance"]);

const artifactTargetSchema = objectSchema({
    instance: nonEmptyString,
    path: nonEmptyString,
    workspace: nonEmptyString,
}, ["instance", "path"]);

const artifactBytePayloadSchema = objectSchema({
    mediaType: nonEmptyString,
    name: nonEmptyString,
    payloadBlake3: nonEmptyString,
    payloadBytes: nonNegativeInteger,
    type: { enum: ["stdout", "stderr", "file"], type: "string" },
}, ["mediaType", "name", "payloadBlake3", "payloadBytes", "type"]);

const artifactDirectoryPayloadSchema = objectSchema({
    entryCount: nonNegativeInteger,
    logicalBytes: nonNegativeInteger,
    manifestBlake3: nonEmptyString,
    mediaType: nonEmptyString,
    name: nonEmptyString,
    payloadBlake3: nonEmptyString,
    payloadBytes: nonNegativeInteger,
    type: { const: "directoryArchive", type: "string" },
}, [
    "entryCount",
    "logicalBytes",
    "manifestBlake3",
    "mediaType",
    "name",
    "payloadBlake3",
    "payloadBytes",
    "type",
]);

const artifactPayloadSchema: JsonValue = {
    anyOf: [artifactBytePayloadSchema, artifactDirectoryPayloadSchema],
};

const artifactTransferFailureSchema = objectSchema({
    code: nonEmptyString,
    message: stringValue,
    retryable: booleanValue,
}, ["code", "message", "retryable"]);

const artifactTransferRecordSchema = objectSchema({
    completedAt: stringValue,
    createdAt: stringValue,
    failure: artifactTransferFailureSchema,
    payload: artifactPayloadSchema,
    source: artifactSourceOutputSchema,
    startedAt: stringValue,
    status: {
        enum: [
            "queued",
            "preparing",
            "transferring",
            "verifying",
            "committing",
            "completed",
            "failed",
            "cancelling",
            "cancelled",
            "interrupted",
        ],
        type: "string",
    },
    target: artifactTargetSchema,
    totalBytes: nonNegativeInteger,
    transferId: nonEmptyString,
    transferredBytes: nonNegativeInteger,
    updatedAt: stringValue,
}, ["createdAt", "source", "status", "target", "transferId", "transferredBytes", "updatedAt"]);

export const artifactTransferOutputSchema = objectSchema({
    operation: { enum: ["start", "status", "cancel"], type: "string" },
    transfer: artifactTransferRecordSchema,
}, ["operation", "transfer"]);

export const artifactShareOutputSchema = objectSchema({
    blake3: nonEmptyString,
    bytes: nonNegativeInteger,
    downloadName: nonEmptyString,
    expiresAtMs: nonNegativeInteger,
    mediaType: nonEmptyString,
    shareId: nonEmptyString,
    source: artifactSourceOutputSchema,
    state: { enum: ["active", "expired", "revoked"], type: "string" },
    url: nonEmptyString,
}, ["blake3", "bytes", "downloadName", "expiresAtMs", "mediaType", "shareId", "source", "state", "url"]);

export const waitRecordOutputSchema = objectSchema({
    cancelledAt: stringValue,
    consumedAt: stringValue,
    createdAt: stringValue,
    createdByCtxId: nonEmptyString,
    detachedAt: stringValue,
    kind: { enum: ["approval", "question", "tmux"], type: "string" },
    ownerCallId: nonEmptyString,
    payload: anyValue,
    recoveryClaimedAt: stringValue,
    recoveryClaimId: nonEmptyString,
    resolvedAt: stringValue,
    result: anyValue,
    status: { enum: ["cancelled", "consumed", "detached", "resolved", "waiting"], type: "string" },
    targetId: nonEmptyString,
    taskId: nonEmptyString,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["createdAt", "createdByCtxId", "kind", "status", "targetId", "updatedAt", "waitId"]);

const approvalDecisionSchema = objectSchema({
    approvalId: nonEmptyString,
    decidedAt: stringValue,
    decidedBy: { enum: ["cli", "tui", "web", "policy"], type: "string" },
    decision: { enum: ["approve", "deny"], type: "string" },
    policyPatch: anyValue,
    reason: stringValue,
    remember: booleanValue,
}, ["approvalId", "decidedAt", "decidedBy", "decision"]);

export const approvalRequestOutputSchema = objectSchema({
    approvalId: nonEmptyString,
    callId: nonEmptyString,
    createdAt: stringValue,
    ctxId: nonEmptyString,
    decision: approvalDecisionSchema,
    expiresAt: stringValue,
    inputSummary: stringValue,
    instance: nonEmptyString,
    reason: stringValue,
    requestId: stringValue,
    riskLevel: { enum: ["low", "medium", "high"], type: "string" },
    source: { enum: ["cli", "tui", "web", "mcp"], type: "string" },
    status: { enum: ["pending", "approved", "denied", "expired", "cancelled"], type: "string" },
    toolName: nonEmptyString,
    workspace: stringValue,
}, ["approvalId", "callId", "createdAt", "expiresAt", "inputSummary", "instance", "reason", "riskLevel", "source", "status", "toolName"]);

const workspaceActivitySchema = objectSchema({
    callId: nonEmptyString,
    completedAt: stringValue,
    error: stringValue,
    inputSummary: stringValue,
    startedAt: stringValue,
    status: {
        enum: ["queued", "pendingApproval", "running", "completed", "failed", "denied", "expired", "queueTimeout", "cancelled"],
        type: "string",
    },
    taskId: nonEmptyString,
    todoItemId: nonEmptyString,
    toolName: nonEmptyString,
}, ["callId", "inputSummary", "startedAt", "status", "toolName"]);

const workspaceBackgroundSchema = objectSchema({
    detachedAt: stringValue,
    status: { enum: ["detached", "resolved", "waiting"], type: "string" },
    taskId: nonEmptyString,
    tmuxTaskId: stringValue,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["status", "tmuxTaskId", "updatedAt", "waitId"]);

const workspaceApprovalEventSchema = objectSchema({
    approvalId: nonEmptyString,
    eventName: { const: "approval.decision", type: "string" },
    inputSummary: stringValue,
    kind: { const: "approval", type: "string" },
    name: nonEmptyString,
    reason: stringValue,
    riskLevel: { enum: ["low", "medium", "high"], type: "string" },
    status: { const: "waiting", type: "string" },
    toolName: nonEmptyString,
    updatedAt: stringValue,
}, ["approvalId", "eventName", "inputSummary", "kind", "name", "riskLevel", "status", "toolName", "updatedAt"]);

const workspaceQuestionEventSchema = objectSchema({
    eventName: { const: "user.answer", type: "string" },
    kind: { const: "question", type: "string" },
    name: { const: "ask_question", type: "string" },
    payload: anyValue,
    status: { enum: ["waiting", "detached"], type: "string" },
    taskId: nonEmptyString,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["eventName", "kind", "name", "status", "updatedAt", "waitId"]);

const workspaceTmuxEventSchema = objectSchema({
    eventName: { const: "tmux.task.completed", type: "string" },
    kind: { const: "tmux", type: "string" },
    name: { const: "tmux_wait", type: "string" },
    status: { const: "waiting", type: "string" },
    taskId: nonEmptyString,
    tmuxTaskId: stringValue,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["eventName", "kind", "name", "status", "updatedAt", "waitId"]);

const workspaceCurrentEventSchema: JsonValue = {
    anyOf: [
        { type: "null" },
        workspaceApprovalEventSchema,
        workspaceQuestionEventSchema,
        workspaceTmuxEventSchema,
    ],
};

const workspaceContextSelectorSchema = objectSchema({
    requiresExplicitContextId: { type: "boolean" },
}, ["requiresExplicitContextId"]);

export const workspaceSnapshotOutputSchema = objectSchema({
    activity: arraySchema(workspaceActivitySchema),
    approvals: arraySchema(approvalRequestOutputSchema),
    background: arraySchema(workspaceBackgroundSchema),
    contextSelector: workspaceContextSelectorSchema,
    ctxId: nonEmptyString,
    currentEvent: workspaceCurrentEventSchema,
    cursor: nonNegativeInteger,
    instance: nonEmptyString,
    questions: arraySchema(waitRecordOutputSchema),
    tasks: arraySchema(todoTaskSummaryOutputSchema),
    waits: arraySchema(waitRecordOutputSchema),
}, ["activity", "approvals", "background", "contextSelector", "currentEvent", "cursor", "instance", "questions", "tasks", "waits"]);

export const workspaceOpenOutputSchema: JsonValue = workspaceSnapshotOutputSchema;

export const workspaceWatchOutputSchema: JsonValue = {
    anyOf: [
        objectSchema({
            changed: { const: false, type: "boolean" },
            cursor: nonNegativeInteger,
        }, ["changed", "cursor"]),
        objectSchema({
            changed: { const: true, type: "boolean" },
            cursor: nonNegativeInteger,
            snapshot: workspaceSnapshotOutputSchema,
        }, ["changed", "cursor", "snapshot"]),
    ],
};

export const workspaceQuestionAnswerOutputSchema = objectSchema({
    answer: stringValue,
    detached: booleanValue,
    questionId: stringValue,
    taskId: nonEmptyString,
    waitId: nonEmptyString,
}, ["answer", "detached", "questionId", "waitId"]);

export const workspaceWaitInterruptOutputSchema = objectSchema({
    interrupted: { const: true, type: "boolean" },
    status: { const: "cancelled", type: "string" },
    tmuxTaskId: stringValue,
    waitId: nonEmptyString,
}, ["interrupted", "status", "tmuxTaskId", "waitId"]);

export const workspaceWaitRecoveryOutputSchema: JsonValue = {
    anyOf: [
        objectSchema({
            claimId: nonEmptyString,
            kind: { enum: ["question", "tmux"], type: "string" },
            result: anyValue,
            taskId: nonEmptyString,
            targetId: stringValue,
            waitId: nonEmptyString,
        }, ["claimId", "kind", "targetId", "taskId", "waitId"]),
        objectSchema({
            completed: { const: true, type: "boolean" },
            kind: { enum: ["question", "tmux"], type: "string" },
            targetId: stringValue,
            waitId: nonEmptyString,
        }, ["completed", "kind", "targetId", "waitId"]),
        objectSchema({
            released: { const: true, type: "boolean" },
            waitId: nonEmptyString,
        }, ["released", "waitId"]),
    ],
};

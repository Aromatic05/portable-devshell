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

const workspaceBackgroundSchema = objectSchema({
    detachedAt: stringValue,
    goalId: nonEmptyString,
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

const workspaceQuestionPayloadSchema = objectSchema({
    allowText: booleanValue,
    choices: arraySchema(nonEmptyString),
    question: nonEmptyString,
}, ["allowText", "choices", "question"]);

const workspaceQuestionEventSchema = objectSchema({
    eventName: { const: "user.answer", type: "string" },
    goalId: nonEmptyString,
    kind: { const: "question", type: "string" },
    name: { const: "workspace_ask", type: "string" },
    payload: workspaceQuestionPayloadSchema,
    status: { enum: ["waiting", "detached"], type: "string" },
    taskId: nonEmptyString,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["eventName", "kind", "name", "status", "updatedAt", "waitId"]);

const workspaceCurrentEventSchema: JsonValue = {
    anyOf: [
        { type: "null" },
        workspaceApprovalEventSchema,
        workspaceQuestionEventSchema,
    ],
};

const workspaceTodoTaskSummaryOutputSchema = objectSchema({
    ...activeTodoSummaryProperties,
    updatedAt: stringValue,
}, ["completed", "revision", "status", "taskId", "title", "total", "updatedAt"]);

const workspaceGoalStepOutputSchema = objectSchema({
    id: nonEmptyString,
    note: stringValue,
    status: { enum: ["pending", "active", "completed", "skipped"], type: "string" },
    text: nonEmptyString,
}, ["id", "status", "text"]);

export const workspaceGoalOutputSchema = objectSchema({
    autoContinueExhausted: booleanValue,
    continuationCount: nonNegativeInteger,
    continuationDue: booleanValue,
    continuationDueAt: nonEmptyString,
    continuationPending: booleanValue,
    continuationRetryAfter: stringValue,
    createdAt: nonEmptyString,
    goalId: nonEmptyString,
    lastAgentActivityAt: nonEmptyString,
    lastContinuationAt: stringValue,
    maxContinuations: nonNegativeInteger,
    note: stringValue,
    objective: nonEmptyString,
    revision: nonNegativeInteger,
    status: { enum: ["active", "blocked", "completed", "stopped"], type: "string" },
    steps: arraySchema(workspaceGoalStepOutputSchema),
    updatedAt: nonEmptyString,
}, [
    "autoContinueExhausted", "continuationCount", "continuationDue", "continuationDueAt",
    "continuationPending", "createdAt", "goalId", "lastAgentActivityAt", "maxContinuations",
    "objective", "revision", "status", "steps", "updatedAt"
]);

export const workspaceGoalResultOutputSchema = objectSchema({
    goal: { anyOf: [{ type: "null" }, workspaceGoalOutputSchema] },
}, ["goal"]);

export const workspaceGoalContinuationOutputSchema = objectSchema({
    claimed: booleanValue,
    claimId: nonEmptyString,
    continuationCount: nonNegativeInteger,
    goal: { anyOf: [{ type: "null" }, workspaceGoalOutputSchema] },
    valid: booleanValue,
}, ["goal"]);

const workspaceQuestionWaitOutputSchema = objectSchema({
    createdAt: stringValue,
    detachedAt: stringValue,
    goalId: nonEmptyString,
    kind: { const: "question", type: "string" },
    payload: workspaceQuestionPayloadSchema,
    status: { enum: ["detached", "waiting"], type: "string" },
    targetId: nonEmptyString,
    taskId: nonEmptyString,
    updatedAt: stringValue,
    waitId: nonEmptyString,
}, ["createdAt", "kind", "status", "targetId", "updatedAt", "waitId"]);

export const workspaceApprovalRequestOutputSchema = objectSchema({
    approvalId: nonEmptyString,
    callId: nonEmptyString,
    createdAt: stringValue,
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

export const workspaceSnapshotOutputSchema: JsonValue = objectSchema({
        approvals: arraySchema(workspaceApprovalRequestOutputSchema),
        background: arraySchema(workspaceBackgroundSchema),
        ctxId: nonEmptyString,
        currentEvent: workspaceCurrentEventSchema,
        cursor: nonNegativeInteger,
        goal: { anyOf: [{ type: "null" }, workspaceGoalOutputSchema] },
        instance: nonEmptyString,
        questions: arraySchema(workspaceQuestionWaitOutputSchema),
        tasks: arraySchema(workspaceTodoTaskSummaryOutputSchema),
}, ["approvals", "background", "ctxId", "currentEvent", "cursor", "goal", "instance", "questions", "tasks"]);

export const workspaceOpenOutputSchema: JsonValue = objectSchema({
    ctxId: nonEmptyString,
    instance: nonEmptyString,
}, ["ctxId", "instance"]);

export const workspaceWatchOutputSchema: JsonValue = objectSchema({
    changed: booleanValue,
    cursor: nonNegativeInteger,
    snapshot: workspaceSnapshotOutputSchema,
}, ["changed", "cursor"]);

export const workspaceQuestionAnswerOutputSchema = objectSchema({
    answer: stringValue,
    detached: booleanValue,
    goalId: nonEmptyString,
    questionId: stringValue,
    taskId: nonEmptyString,
    waitId: nonEmptyString,
}, ["answer", "detached", "questionId", "waitId"]);

export const workspaceWaitInterruptOutputSchema = objectSchema({
    detached: booleanValue,
    goalId: nonEmptyString,
    interrupted: { const: true, type: "boolean" },
    status: { const: "resolved", type: "string" },
    taskId: nonEmptyString,
    tmuxTaskId: stringValue,
    waitId: nonEmptyString,
}, ["detached", "interrupted", "status", "tmuxTaskId", "waitId"]);

export const workspaceWaitRecoveryOutputSchema = objectSchema({
    claimId: nonEmptyString,
    completed: { const: true, type: "boolean" },
    goalId: nonEmptyString,
    kind: { enum: ["question", "tmux"], type: "string" },
    recoveryMessageId: nonEmptyString,
    recoveryMessageSentAt: stringValue,
    released: { const: true, type: "boolean" },
    sent: { const: true, type: "boolean" },
    result: anyValue,
    taskId: nonEmptyString,
    targetId: stringValue,
    waitId: nonEmptyString,
}, ["waitId"]);

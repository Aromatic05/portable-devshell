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

const todoCheckpointSchema = objectSchema(
    {
        blockers: arraySchema(stringValue),
        next: stringValue,
        summary: stringValue,
        updatedAt: stringValue,
    },
    ["summary", "updatedAt"],
);

const todoItemSchema = objectSchema(
    {
        content: stringValue,
        detail: stringValue,
        id: nonEmptyString,
        status: {
            enum: [
                "pending",
                "in_progress",
                "blocked",
                "completed",
                "failed",
                "cancelled",
            ],
            type: "string",
        },
    },
    ["content", "id", "status"],
);

const todoSummarySchema = objectSchema(
    {
        completed: nonNegativeInteger,
        currentItemId: stringValue,
        total: nonNegativeInteger,
    },
    ["completed", "total"],
);

const activeTodoSummaryProperties: Record<string, JsonValue> = {
    checkpoint: todoCheckpointSchema,
    completed: nonNegativeInteger,
    currentItem: stringValue,
    pausedAt: stringValue,
    revision: nonNegativeInteger,
    status: {
        enum: [
            "pending",
            "in_progress",
            "blocked",
            "completed",
            "failed",
            "cancelled",
            "none",
            "paused",
        ],
        type: "string",
    },
    taskId: nonEmptyString,
    title: stringValue,
    total: nonNegativeInteger,
};

const activeTodoSummaryOutputSchema = objectSchema(
    activeTodoSummaryProperties,
    ["completed", "revision", "status", "taskId", "title", "total"],
);

export const todoTaskSummaryOutputSchema = objectSchema(
    {
        ...activeTodoSummaryProperties,
        ctxId: nonEmptyString,
        updatedAt: stringValue,
    },
    [
        "completed",
        "revision",
        "status",
        "taskId",
        "title",
        "total",
        "updatedAt",
    ],
);

export const todoReadOutputSchema = objectSchema(
    {
        cancelledAt: stringValue,
        checkpoint: todoCheckpointSchema,
        items: arraySchema(todoItemSchema),
        pausedAt: stringValue,
        revision: nonNegativeInteger,
        summary: todoSummarySchema,
        taskId: nonEmptyString,
        tasks: arraySchema(todoTaskSummaryOutputSchema),
        title: stringValue,
    },
    ["items", "revision", "summary"],
);

const reverseInstanceStatusSchema = objectSchema(
    {
        availability: { enum: ["offline", "online"], type: "string" },
        connectedAt: stringValue,
        enrollmentState: {
            enum: ["pending", "enrolled", "revoked"],
            type: "string",
        },
        generation: nonNegativeInteger,
        lastErrorCode: stringValue,
        lastErrorMessage: stringValue,
        lastSeenAt: stringValue,
        managementMode: { const: "selfManaged", type: "string" },
        transport: { enum: ["wss", "sse"], type: "string" },
    },
    ["availability", "enrollmentState", "managementMode"],
);

const instanceSnapshotProperties: Record<string, JsonValue> = {
    activeTodos: arraySchema(activeTodoSummaryOutputSchema),
    connectionState: {
        enum: [
            "connected",
            "connecting",
            "disconnected",
            "reconnecting",
            "failed",
        ],
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
    status: {
        enum: ["ready", "running", "stale", "stopped", "failed"],
        type: "string",
    },
};

export const instanceSnapshotOutputSchema = objectSchema(
    instanceSnapshotProperties,
    ["connectionState", "daemonState", "lastSeq", "name", "ready", "status"],
);

const instanceDescriptorSchema = objectSchema(
    {
        enabled: booleanValue,
        mcpEnabled: booleanValue,
        name: nonEmptyString,
        provider: {
            enum: ["local", "ssh", "docker", "podman", "reverse"],
            type: "string",
        },
        snapshot: instanceSnapshotOutputSchema,
    },
    ["enabled", "mcpEnabled", "name", "snapshot"],
);

export const instanceStatusOutputSchema = instanceDescriptorSchema;

export const instanceListOutputSchema = objectSchema(
    {
        instances: arraySchema(instanceDescriptorSchema),
    },
    ["instances"],
);

export const instanceCreateOutputSchema = objectSchema(
    {
        enabled: booleanValue,
        mcpPath: nonEmptyString,
        name: nonEmptyString,
        snapshot: instanceSnapshotOutputSchema,
    },
    ["enabled", "name"],
);

export const artifactSourceOutputSchema = objectSchema(
    {
        handle: nonEmptyString,
        instance: nonEmptyString,
        path: nonEmptyString,
        type: { enum: ["artifact", "file", "directory"], type: "string" },
        workspace: nonEmptyString,
    },
    ["instance"],
);

export const artifactShareOutputSchema = objectSchema(
    {
        blake3: nonEmptyString,
        bytes: nonNegativeInteger,
        downloadName: nonEmptyString,
        expiresAtMs: nonNegativeInteger,
        mediaType: nonEmptyString,
        shareId: nonEmptyString,
        source: artifactSourceOutputSchema,
        state: { enum: ["active", "expired", "revoked"], type: "string" },
        url: nonEmptyString,
    },
    [
        "blake3",
        "bytes",
        "downloadName",
        "expiresAtMs",
        "mediaType",
        "shareId",
        "source",
        "state",
        "url",
    ],
);

const approvalDecisionSchema = objectSchema(
    {
        approvalId: nonEmptyString,
        decidedAt: stringValue,
        decidedBy: { enum: ["cli", "tui", "web", "policy"], type: "string" },
        decision: { enum: ["approve", "deny"], type: "string" },
        policyPatch: anyValue,
        reason: stringValue,
        remember: booleanValue,
    },
    ["approvalId", "decidedAt", "decidedBy", "decision"],
);

export const approvalRequestOutputSchema = objectSchema(
    {
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
        status: {
            enum: ["pending", "approved", "denied", "expired", "cancelled"],
            type: "string",
        },
        toolName: nonEmptyString,
        workspace: stringValue,
    },
    [
        "approvalId",
        "callId",
        "createdAt",
        "expiresAt",
        "inputSummary",
        "instance",
        "reason",
        "riskLevel",
        "source",
        "status",
        "toolName",
    ],
);

const workspaceGoalStepOutputSchema = objectSchema(
    {
        id: nonEmptyString,
        note: stringValue,
        status: {
            enum: ["pending", "active", "completed", "skipped"],
            type: "string",
        },
        text: nonEmptyString,
    },
    ["id", "status", "text"],
);

export const workspaceGoalOutputSchema = objectSchema(
    {
        autoContinueExhausted: booleanValue,
        continuationAttemptedAt: stringValue,
        continuationCount: nonNegativeInteger,
        continuationMessageId: nonEmptyString,
        continuationDue: booleanValue,
        continuationDueAt: nonEmptyString,
        continuationPending: booleanValue,
        continuationRetryAfter: stringValue,
        continuationUncertain: booleanValue,
        createdAt: nonEmptyString,
        goalId: nonEmptyString,
        lastAgentActivityAt: nonEmptyString,
        lastExecutionAt: stringValue,
        lastReentryAt: stringValue,
        lastContinuationAt: stringValue,
        lastProgressAt: nonEmptyString,
        maxContinuations: nonNegativeInteger,
        noActionStreak: nonNegativeInteger,
        note: stringValue,
        objective: nonEmptyString,
        progressEpoch: nonNegativeInteger,
        revision: nonNegativeInteger,
        stagnationStreak: nonNegativeInteger,
        status: {
            enum: ["active", "blocked", "paused", "completed", "stopped"],
            type: "string",
        },
        steps: arraySchema(workspaceGoalStepOutputSchema),
        updatedAt: nonEmptyString,
        workspace: stringValue,
    },
    [
        "autoContinueExhausted",
        "continuationCount",
        "continuationDue",
        "continuationDueAt",
        "continuationPending",
        "continuationUncertain",
        "createdAt",
        "goalId",
        "lastAgentActivityAt",
        "lastProgressAt",
        "maxContinuations",
        "objective",
        "revision",
        "status",
        "steps",
        "updatedAt",
    ],
);

export const workspaceGoalResultOutputSchema = objectSchema(
    {
        goal: { anyOf: [{ type: "null" }, workspaceGoalOutputSchema] },
    },
    ["goal"],
);

export const workspaceGoalContinuationOutputSchema = objectSchema(
    {
        attempted: booleanValue,
        claimed: booleanValue,
        claimId: nonEmptyString,
        continuationCount: nonNegativeInteger,
        messageId: nonEmptyString,
        goal: { anyOf: [{ type: "null" }, workspaceGoalOutputSchema] },
        valid: booleanValue,
    },
    ["goal"],
);

export const workspaceReentryOutputSchema = objectSchema(
    {
        claimId: nonEmptyString,
        claimed: booleanValue,
        epoch: nonNegativeInteger,
        mode: { enum: ["automatic", "user_owned", "paused"], type: "string" },
        pending: booleanValue,
        reason: stringValue,
        released: booleanValue,
        resumed: booleanValue,
        suppressed: booleanValue,
        suppressedAt: stringValue,
        valid: booleanValue,
    },
    ["epoch", "pending"],
);

export const workspaceApprovalRequestOutputSchema = objectSchema(
    {
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
        status: {
            enum: ["pending", "approved", "denied", "expired", "cancelled"],
            type: "string",
        },
        toolName: nonEmptyString,
        workspace: stringValue,
    },
    [
        "approvalId",
        "callId",
        "createdAt",
        "expiresAt",
        "inputSummary",
        "instance",
        "reason",
        "riskLevel",
        "source",
        "status",
        "toolName",
    ],
);

const workspaceActionSchema = objectSchema(
    {
        id: nonEmptyString,
        label: nonEmptyString,
        tone: { enum: ["default", "primary", "danger"], type: "string" },
        confirmation: objectSchema({ message: nonEmptyString }, ["message"]),
        input: {
            anyOf: [
                objectSchema({ kind: { const: "none", type: "string" } }, [
                    "kind",
                ]),
                objectSchema(
                    {
                        kind: { const: "text", type: "string" },
                        placeholder: stringValue,
                    },
                    ["kind"],
                ),
                objectSchema(
                    {
                        kind: { const: "choice", type: "string" },
                        choices: arraySchema(
                            objectSchema(
                                { id: nonEmptyString, label: nonEmptyString },
                                ["id", "label"],
                            ),
                        ),
                    },
                    ["kind", "choices"],
                ),
            ],
        },
    },
    ["id", "label"],
);
const workspaceChoiceSchema = objectSchema(
    { id: nonEmptyString, label: nonEmptyString },
    ["id", "label"],
);
const workspaceDecisionSchema = objectSchema(
    {
        kind: { const: "decision", type: "string" },
        id: nonEmptyString,
        title: nonEmptyString,
        badge: stringValue,
        summary: stringValue,
        detail: stringValue,
        actions: arraySchema(workspaceActionSchema),
    },
    ["kind", "id", "title", "actions"],
);
const workspaceQuestionSchema = objectSchema(
    {
        kind: { const: "question", type: "string" },
        id: nonEmptyString,
        title: nonEmptyString,
        prompt: stringValue,
        input: {
            anyOf: [
                objectSchema(
                    {
                        kind: { const: "text", type: "string" },
                        placeholder: stringValue,
                    },
                    ["kind"],
                ),
                objectSchema(
                    {
                        kind: { const: "choice", type: "string" },
                        choices: arraySchema(workspaceChoiceSchema),
                        allowText: booleanValue,
                    },
                    ["kind", "choices"],
                ),
            ],
        },
        actions: arraySchema(workspaceActionSchema),
    },
    ["kind", "id", "title", "prompt", "input", "actions"],
);
const workspaceWorkSchema = objectSchema(
    {
        kind: { const: "work", type: "string" },
        id: nonEmptyString,
        title: nonEmptyString,
        state: { enum: ["running", "paused", "blocked"], type: "string" },
        badge: stringValue,
        detail: stringValue,
        current: stringValue,
        note: stringValue,
        progress: objectSchema(
            { current: nonNegativeInteger, total: nonNegativeInteger },
            ["current", "total"],
        ),
        actions: arraySchema(workspaceActionSchema),
    },
    ["kind", "id", "title", "state", "actions"],
);
const workspaceBackgroundItemSchema = objectSchema(
    {
        kind: { const: "background", type: "string" },
        id: nonEmptyString,
        title: nonEmptyString,
        badge: stringValue,
        summary: stringValue,
        detail: stringValue,
        actions: arraySchema(workspaceActionSchema),
    },
    ["kind", "id", "title", "actions"],
);
const workspaceDirectiveSchema = objectSchema(
    {
        kind: { const: "reentry", type: "string" },
        id: nonEmptyString,
        intent: {
            enum: ["automatic", "goal-resume", "goal-retry", "task-resume"],
            type: "string",
        },
        sourceId: nonEmptyString,
    },
    ["kind", "id", "intent"],
);
const workspaceSnapshotSchema = objectSchema(
    {
        ctxId: nonEmptyString,
        instance: nonEmptyString,
        cursor: nonNegativeInteger,
        agentBusy: booleanValue,
        presentation: objectSchema(
            {
                primary: {
                    anyOf: [workspaceDecisionSchema, workspaceQuestionSchema],
                },
                work: arraySchema(workspaceWorkSchema),
                background: arraySchema(workspaceBackgroundItemSchema),
            },
            ["work", "background"],
        ),
        modelContext: objectSchema(
            {
                content: arraySchema(
                    objectSchema(
                        {
                            type: { const: "text", type: "string" },
                            text: stringValue,
                        },
                        ["type", "text"],
                    ),
                ),
                structuredContent: objectSchema(
                    { portableDevshellWorkspace: anyValue },
                    ["portableDevshellWorkspace"],
                ),
            },
            ["content", "structuredContent"],
        ),
        reentry: objectSchema(
            {
                pending: booleanValue,
                executionActive: booleanValue,
                schedule: objectSchema(
                    {
                        readyAt: nonEmptyString,
                        intent: { const: "automatic", type: "string" },
                        sourceId: nonEmptyString,
                    },
                    ["readyAt", "intent"],
                ),
                delivery: objectSchema(
                    {
                        status: {
                            enum: ["idle", "uncertain", "paused"],
                            type: "string",
                        },
                    },
                    ["status"],
                ),
                directives: arraySchema(workspaceDirectiveSchema),
            },
            ["pending"],
        ),
    },
    [
        "ctxId",
        "instance",
        "cursor",
        "agentBusy",
        "presentation",
        "modelContext",
        "reentry",
    ],
);

export const workspaceSnapshotOutputSchema: JsonValue = workspaceSnapshotSchema;
export const workspaceActionOutputSchema: JsonValue = objectSchema(
    {
        status: { enum: ["applied", "stale"], type: "string" },
        snapshot: workspaceSnapshotSchema,
        effect: workspaceDirectiveSchema,
    },
    ["status", "snapshot"],
);

export const workspaceOpenOutputSchema: JsonValue = objectSchema(
    {
        ctxId: nonEmptyString,
        instance: nonEmptyString,
    },
    ["ctxId", "instance"],
);

export const workspaceWatchOutputSchema: JsonValue = objectSchema(
    {
        changed: booleanValue,
        cursor: nonNegativeInteger,
        snapshot: workspaceSnapshotOutputSchema,
    },
    ["changed", "cursor"],
);

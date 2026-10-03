/**
 * Context model.
 *
 * Owns the MCP Context record acquired from a control host and the authority
 * vocabulary used to bind, validate, and re-enter Contexts: its status,
 * environment attachments, external bindings, remote instance references,
 * cleanup obligations, automatic-reentry state, and query shape. Context
 * messages and the Conversation surface live in their own subdomains.
 *
 * The record carries only the authoritative environment list; an "initial"
 * environment is whichever entry the authority attached first, not a second
 * copy of the same data.
 */

export type McpContextStatus = "active" | "expired" | "disabled";

export interface McpContextEnvironment {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface McpContextRecord {
    createdAt: string;
    ctxId: string;
    environments: McpContextEnvironment[];
    expiresAt: string;
    lastAccessedAt: string;
    principal: string;
    status: McpContextStatus;
}

export interface McpContextBinding {
    principal: string;
    environments?: McpContextEnvironment[];
}

export interface McpContextEnvironmentBinding {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface McpContextValidationBinding {
    principal: string;
}

export interface McpContextExternalBinding {
    kind: string;
    value: string;
}

export interface McpContextInstanceReference {
    current: boolean;
    handle?: string;
}

export interface McpContextMaskedInstance {
    environment?: McpContextEnvironment;
    instance: string;
}

export type McpContextEnvironmentCleanup =
    | { instance: string; kind: "alerts"; workspace: string }
    | { instance: string; kind: "instance_reference" };

export type McpContextAutomaticReentryMode =
    "automatic" | "user_owned" | "paused";
export type McpContextAutomaticReentrySourceKind =
    "goal" | "goal-resume" | "goal-retry" | "task-resume" | "wait";

export interface McpContextAutomaticReentryState {
    attempted: boolean;
    claimId?: string;
    epoch: number;
    executionActive: boolean;
    executionEpoch: number;
    executionLastActivityAt?: string;
    executionLeaseUntil?: string;
    mode: McpContextAutomaticReentryMode;
    pending: boolean;
    reason?: string;
    sourceId?: string;
    sourceKind?: McpContextAutomaticReentrySourceKind;
    suppressedAt?: string;
}

export interface McpContextQuery {
    instance?: string;
    workspace?: string;
    status?: McpContextStatus;
}

// Interaction Context bounded-context error codes. These describe MCP Context
// lifecycle failures (expired/disabled/invalid/renewal/workspace). The values
// are the wire codes carried in RemoteErrorBody.code.

export const contextErrorCodes = {
    disabled: "mcp.contextDisabled",
    expired: "mcp.contextExpired",
    instanceMasked: "mcp.contextInstanceMasked",
    invalid: "mcp.contextInvalid",
    workspaceRequired: "mcp.contextWorkspaceRequired",
} as const;

export type ContextErrorCode =
    (typeof contextErrorCodes)[keyof typeof contextErrorCodes];

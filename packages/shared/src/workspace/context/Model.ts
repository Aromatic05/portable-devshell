/**
 * Context model.
 *
 * Owns the Context record acquired from a control host and the authority
 * vocabulary used to bind and validate Contexts: its status,
 * environment attachments, external bindings, remote instance references,
 * cleanup obligations, and query shape. Context messages and the Message
 * surface live in their own subdomains.
 *
 * The record carries only the authoritative environment list; an "initial"
 * environment is whichever entry the authority attached first, not a second
 * copy of the same data.
 */

export type ContextStatus = "active" | "expired" | "disabled";

export interface ContextEnvironment {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface ContextRecord {
    createdAt: string;
    ctxId: string;
    environments: ContextEnvironment[];
    expiresAt: string;
    lastAccessedAt: string;
    principal: string;
    status: ContextStatus;
}

export interface ContextBinding {
    principal: string;
    environments?: ContextEnvironment[];
}

export interface ContextEnvironmentBinding {
    instance: string;
    temporaryDirectory?: string;
    workspace?: string;
}

export interface ContextValidationBinding {
    principal: string;
}

export interface ContextExternalBinding {
    kind: string;
    value: string;
}

export interface ContextInstanceReference {
    current: boolean;
    handle?: string;
}

export interface ContextMaskedInstance {
    environment?: ContextEnvironment;
    instance: string;
}

export type ContextEnvironmentCleanup =
    | { instance: string; kind: "alerts"; workspace: string }
    | { instance: string; kind: "instance_reference" };

export interface ContextQuery {
    instance?: string;
    workspace?: string;
    status?: ContextStatus;
}

// Context authority error codes. The wire values retain their historical
// mcp.context* names for protocol compatibility.

export const contextErrorCodes = {
    disabled: "mcp.contextDisabled",
    expired: "mcp.contextExpired",
    instanceMasked: "mcp.contextInstanceMasked",
    invalid: "mcp.contextInvalid",
    workspaceRequired: "mcp.contextWorkspaceRequired",
} as const;

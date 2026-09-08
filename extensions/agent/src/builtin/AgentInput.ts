import type { ExtensionJsonValue } from "@portable-devshell/extension";

export interface AgentStartInput {
    provider?: string;
    target: string;
}

export interface AgentMessageInput {
    agentId: string;
    message: string;
}

export function readStartInput(value: ExtensionJsonValue | undefined): AgentStartInput {
    const input = readRecord(value, "agent.start requires an object payload.");
    assertOnlyKeys(input, ["provider", "target"]);
    const provider = readOptionalString(input.provider, "provider");
    return {
        ...(provider === undefined ? {} : { provider }),
        target: readString(input.target, "target")
    };
}

export function readMessageInput(value: ExtensionJsonValue | undefined): AgentMessageInput {
    const input = readRecord(value, "Agent message requires an object payload.");
    assertOnlyKeys(input, ["agentId", "message"]);
    return {
        agentId: readString(input.agentId, "agentId"),
        message: readString(input.message, "message")
    };
}

export function readAgentId(value: ExtensionJsonValue | undefined): string {
    const input = readRecord(value, "Agent request requires an object payload.");
    assertOnlyKeys(input, ["agentId"]);
    return readString(input.agentId, "agentId");
}

function readRecord(value: ExtensionJsonValue | undefined, message: string): Record<string, ExtensionJsonValue> {
    if (typeof value === "object" && value !== null && !Array.isArray(value)) return value;
    throw new TypeError(message);
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    throw new TypeError(`${field} must be a non-empty string.`);
}

function readOptionalString(value: ExtensionJsonValue | undefined, field: string): string | undefined {
    return value === undefined ? undefined : readString(value, field);
}

function assertOnlyKeys(value: Record<string, ExtensionJsonValue>, allowed: readonly string[]): void {
    const keys = new Set(allowed);
    const unknown = Object.keys(value).find((key) => !keys.has(key));
    if (unknown !== undefined) {
        throw new TypeError(`Agent request accepts only: ${allowed.join(", ")}.`);
    }
}

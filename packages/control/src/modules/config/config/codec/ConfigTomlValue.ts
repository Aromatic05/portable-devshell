import type {
    ApprovalPolicyDecision,
    ApprovalPolicyMode,
    ApprovalPolicySourceScope,
    InstanceContainerMountConfig,
    ToolCapability
} from "@portable-devshell/shared";
import type { TomlTableWithoutBigInt } from "smol-toml";

import type { ControlMcpAuthMode, ControlProviderKind } from "./ConfigTomlTypes.js";

export type TomlRecord = TomlTableWithoutBigInt;

export function withoutUndefined<T extends object>(record: T): Partial<T> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

export function isRecord(value: unknown): value is TomlRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asRecord(value: unknown, fieldName: string): TomlRecord {
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be a table`);
    }

    return value;
}

export function asOptionalRecord(value: unknown, fieldName: string): TomlRecord | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asRecord(value, fieldName);
}

export function asString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

export function asOptionalString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asString(value, fieldName);
}

export function asBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${fieldName} must be a boolean`);
    }

    return value;
}

export function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asBoolean(value, fieldName);
}

export function asInteger(value: unknown, fieldName: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${fieldName} must be an integer`);
    }

    return value;
}

export function asOptionalInteger(value: unknown, fieldName: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asInteger(value, fieldName);
}

export function asStringArray(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${fieldName} must be a string array`);
    }

    return [...value];
}

export function asToolCapabilityArray(value: unknown, fieldName: string): ToolCapability[] {
    return asStringArray(value, fieldName).map((entry) => {
        if (entry === "read" || entry === "write" || entry === "execute" || entry === "manage") {
            return entry;
        }
        throw new Error(`${fieldName} must contain only read, write, execute, or manage`);
    });
}

export function asOptionalArray(value: unknown, fieldName: string): unknown[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }

    return [...value];
}

export function asStringRecord(value: TomlRecord, fieldName: string): Record<string, string> {
    const entries = Object.entries(value);
    const record: Record<string, string> = {};

    for (const [key, entryValue] of entries) {
        if (typeof entryValue !== "string") {
            throw new Error(`${fieldName}.${key} must be a string`);
        }

        record[key] = entryValue;
    }

    return record;
}

export function asProviderKind(value: string): ControlProviderKind {
    if (value === "local" || value === "ssh" || value === "docker" || value === "podman" || value === "reverse") {
        return value;
    }

    throw new Error(`unsupported provider: ${value}`);
}

export function asAuthMode(value: string): ControlMcpAuthMode {
    if (value === "none" || value === "token" || value === "oauth2") {
        return value;
    }

    throw new Error(`unsupported mcp.auth.mode: ${value}`);
}

export function asApprovalPolicyMode(value: string): ApprovalPolicyMode {
    if (value === "disabled" || value === "allow" || value === "ask" || value === "deny") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.mode: ${value}`);
}

export function asApprovalPolicyDecision(value: string): ApprovalPolicyDecision {
    if (value === "allow" || value === "ask" || value === "deny") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].decision: ${value}`);
}

export function asApprovalPolicyMatch(value: string): "exact" {
    if (value === "exact") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].match: ${value}`);
}

export function asApprovalPolicySourceScope(value: string): ApprovalPolicySourceScope {
    if (value === "all" || value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].source: ${value}`);
}

export function asMountMode(value: string): InstanceContainerMountConfig["mode"] {
    if (value === "ro" || value === "rw") {
        return value;
    }

    throw new Error(`unsupported mount mode: ${value}`);
}

export function asOptionalMountSelinuxMode(value: unknown, fieldName: string): InstanceContainerMountConfig["selinux"] {
    if (value === undefined) {
        return undefined;
    }

    const normalized = asString(value, fieldName);
    if (normalized === "private" || normalized === "shared") {
        return normalized;
    }

    throw new Error(`${fieldName} must be one of private, shared`);
}

export function isStructuredConfigError(error: unknown): error is { code: string } {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

export function readFieldPath(message: string): string | undefined {
    const match = message.match(/^([A-Za-z0-9_.[\]]+)\s+/u);
    return match?.[1];
}

export function assertNever(value: never): never {
    throw new Error(`unsupported container mode: ${String(value)}`);
}

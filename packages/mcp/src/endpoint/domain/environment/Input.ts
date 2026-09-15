import {
    createError,
    errorCodes,
    type JsonValue,
} from "@portable-devshell/shared";

export function readMcpEnvironmentInfoInput(
    input: JsonValue,
    options: { allowContextId?: boolean } = {},
): { ctxId?: string; workspace?: string } {
    const allowContextId = options.allowContextId !== false;
    if (
        !isRecord(input) ||
        Object.keys(input).some(
            (key) =>
                key !== "workspace" && (!allowContextId || key !== "ctxId"),
        )
    ) {
        throw invalidArguments(
            allowContextId
                ? "environ_info accepts only optional ctxId and workspace."
                : "environ_info accepts only optional workspace when Context authority is externally bound.",
        );
    }
    const ctxId = allowContextId
        ? optionalString(input.ctxId, "ctxId")
        : undefined;
    const workspace = optionalString(input.workspace, "workspace");
    return {
        ...(ctxId === undefined ? {} : { ctxId }),
        ...(workspace === undefined ? {} : { workspace }),
    };
}

export function readMcpRemoteEnvironmentInput(
    input: JsonValue,
    options: { allowContextId?: boolean } = {},
): { command: string; ctxId?: string; handle?: string; workspace?: string } {
    const allowContextId = options.allowContextId !== false;
    if (
        !isRecord(input) ||
        Object.keys(input).some(
            (key) =>
                key !== "command" &&
                key !== "handle" &&
                key !== "workspace" &&
                (!allowContextId || key !== "ctxId"),
        )
    ) {
        throw invalidArguments(
            allowContextId
                ? "environ_remote accepts command plus optional ctxId, handle, and workspace."
                : "environ_remote accepts command plus optional handle and workspace when Context authority is externally bound.",
        );
    }
    const command = requiredString(input.command, "command");
    const ctxId = allowContextId
        ? optionalString(input.ctxId, "ctxId")
        : undefined;
    const handle = optionalString(input.handle, "handle");
    const workspace = optionalString(input.workspace, "workspace");
    return {
        command,
        ...(ctxId === undefined ? {} : { ctxId }),
        ...(handle === undefined ? {} : { handle }),
        ...(workspace === undefined ? {} : { workspace }),
    };
}

function requiredString(value: JsonValue | undefined, field: string): string {
    const normalized = optionalString(value, field);
    if (normalized === undefined)
        throw invalidArguments(`${field} is required.`);
    return normalized;
}

function optionalString(
    value: JsonValue | undefined,
    field: string,
): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim().length === 0)
        throw invalidArguments(`${field} must be a non-empty string.`);
    return value.trim();
}

function invalidArguments(message: string) {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false,
    });
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

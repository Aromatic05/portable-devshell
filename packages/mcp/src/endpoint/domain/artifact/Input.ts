import {
    createError,
    errorCodes,
    type ArtifactViewImageInput,
    type JsonValue,
} from "@portable-devshell/shared";

export function readMcpArtifactViewImageInput(
    input: JsonValue,
): ArtifactViewImageInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_viewImage requires an object input.");
    }
    const handle = optionalString(input.handle, "handle");
    const path = optionalString(input.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArguments(
            "artifact_viewImage requires exactly one of handle or path.",
        );
    }
    const instance = optionalString(input.instance, "instance");
    const common = instance === undefined ? {} : { instance };
    if (handle !== undefined) return { ...common, handle };
    if (path === undefined)
        throw invalidArguments(
            "artifact_viewImage requires path when handle is omitted.",
        );
    return {
        ...common,
        path,
        workspace: requiredString(input.workspace, "workspace"),
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

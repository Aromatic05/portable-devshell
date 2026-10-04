import {
    createRemoteError,
    contextErrorCodes,
    controlErrorCodes,
    type ArtifactViewImageInput,
    type JsonValue,
} from "@portable-devshell/shared";

export function readArtifactViewImageInput(
    input: JsonValue,
    workspace: string | undefined,
): ArtifactViewImageInput {
    if (!isRecord(input)) {
        throw invalidArguments("artifact_viewImage requires an object input.");
    }
    if (Object.keys(input).some((key) => key !== "handle" && key !== "path"))
        throw invalidArguments("artifact_viewImage accepts only handle or path.");
    const handle = optionalString(input.handle, "handle");
    const path = optionalString(input.path, "path");
    if ((handle === undefined) === (path === undefined)) {
        throw invalidArguments(
            "artifact_viewImage requires exactly one of handle or path.",
        );
    }
    if (handle !== undefined) return { handle };
    if (path === undefined)
        throw invalidArguments(
            "artifact_viewImage requires path when handle is omitted.",
        );
    return {
        path,
        workspace: requireWorkspace(workspace),
    };
}

function requireWorkspace(workspace: string | undefined): string {
    if (workspace !== undefined && workspace.length > 0) return workspace;
    throw createRemoteError({
        code: contextErrorCodes.workspaceRequired,
        message:
            "Artifact path operations require a workspace attachment on the selected instance.",
        retryable: false,
    });
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
    return createRemoteError({
        code: controlErrorCodes.invalidTarget,
        message,
        retryable: false,
    });
}

function isRecord(
    value: JsonValue | undefined,
): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

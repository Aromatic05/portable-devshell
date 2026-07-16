import {
    createError,
    errorCodes,
    type ArtifactPayloadDescriptor,
    type ArtifactShareInput,
    type ArtifactSourceDescriptor,
    type ArtifactTransferStartInput
} from "@portable-devshell/shared";

import type { ArtifactPayloadSourceInput } from "./ArtifactServiceTypes.js";

export function readSharePayloadSourceInput(input: ArtifactShareInput): ArtifactPayloadSourceInput {
    const handle = "handle" in input ? input.handle : undefined;
    const path = "path" in input ? input.path : undefined;
    if (typeof handle === "string" && handle.length > 0 && path === undefined) {
        return { handle };
    }
    if (typeof path === "string" && path.length > 0 && handle === undefined) {
        return { path };
    }
    throw createError({
        code: errorCodes.targetInvalid,
        message: "Exactly one of handle or path is required.",
        retryable: false
    });
}

export function readTransferPayloadSourceInput(input: ArtifactTransferStartInput): ArtifactPayloadSourceInput {
    if (typeof input.handle === "string" && input.handle.length > 0 && input.sourcePath === undefined) {
        return { handle: input.handle };
    }
    if (typeof input.sourcePath === "string" && input.sourcePath.length > 0 && input.handle === undefined) {
        return { path: input.sourcePath };
    }
    throw createError({
        code: errorCodes.targetInvalid,
        message: "Exactly one of handle or sourcePath is required.",
        retryable: false
    });
}

export function readSourceInstance(instance: string | undefined, defaultInstance: string): string {
    const resolved = instance ?? defaultInstance;
    if (resolved.length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Artifact source instance is required.",
            retryable: false
        });
    }
    return resolved;
}

export function validateTransferStart(input: ArtifactTransferStartInput): void {
    if (input.operation !== "start") {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Artifact transfer start requires operation=start.",
            retryable: false
        });
    }
    readTransferPayloadSourceInput(input);
    if (input.targetInstance.length === 0 || input.targetPath.length === 0) {
        throw createError({
            code: errorCodes.targetInvalid,
            message: "Artifact transfer requires targetInstance and targetPath.",
            retryable: false
        });
    }
}

export function sourceDescriptor(
    instance: string,
    input: ArtifactPayloadSourceInput,
    payload: ArtifactPayloadDescriptor
): ArtifactSourceDescriptor {
    return {
        instance,
        ...(inputHasHandle(input) ? { handle: input.handle } : { path: input.path }),
        type: sourceTypeFromPayload(payload)
    };
}

export function sourceTypeFromPayload(
    payload: ArtifactPayloadDescriptor
): "artifact" | "file" | "directory" {
    switch (payload.type) {
        case "stdout":
        case "stderr":
            return "artifact";
        case "file":
            return "file";
        case "directoryArchive":
            return "directory";
    }
}

function inputHasHandle(input: ArtifactPayloadSourceInput): input is { handle: string } {
    return "handle" in input;
}

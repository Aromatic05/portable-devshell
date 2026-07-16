import {
    createError,
    errorCodes,
    type ArtifactShareInput,
    type ArtifactTransferStartInput,
    type JsonValue
} from "@portable-devshell/shared";

export function readArtifactShareInput(params?: JsonValue): ArtifactShareInput {
    if (!isRecord(params)) throw invalid("artifact.createShare requires parameters.");
    const expiresInSeconds = readPositiveInteger(params.expiresInSeconds, "expiresInSeconds");
    const instance = readOptionalString(params.instance, "instance");
    const handle = readOptionalString(params.handle, "handle");
    const path = readOptionalString(params.path, "path");
    if ((handle === undefined) === (path === undefined)) throw invalid("Exactly one of handle or path is required.");
    return handle === undefined
        ? { ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }), ...(instance === undefined ? {} : { instance }), path: path! }
        : { ...(expiresInSeconds === undefined ? {} : { expiresInSeconds }), handle, ...(instance === undefined ? {} : { instance }) };
}

export function readArtifactTransferStartInput(params?: JsonValue): ArtifactTransferStartInput {
    if (!isRecord(params)) throw invalid("artifact.startTransfer requires parameters.");
    const instance = readOptionalString(params.instance, "instance");
    const handle = readOptionalString(params.handle, "handle");
    const sourcePath = readOptionalString(params.sourcePath, "sourcePath");
    const targetInstance = readRequiredString(params.targetInstance, "targetInstance");
    const targetPath = readRequiredString(params.targetPath, "targetPath");
    if ((handle === undefined) === (sourcePath === undefined)) throw invalid("Exactly one of handle or sourcePath is required.");
    if (params.overwrite !== undefined && typeof params.overwrite !== "boolean") throw invalid("overwrite must be a boolean.");
    const common = {
        operation: "start" as const,
        ...(instance === undefined ? {} : { instance }),
        ...(params.overwrite === undefined ? {} : { overwrite: params.overwrite }),
        targetInstance,
        targetPath
    };
    return handle === undefined ? { ...common, sourcePath: sourcePath! } : { ...common, handle };
}

export function readDefaultInstance(params?: JsonValue): string {
    if (!isRecord(params)) throw invalid("Artifact request requires a source instance.");
    const explicit = readOptionalString(params.defaultInstance, "defaultInstance");
    const source = readOptionalString(params.instance, "instance");
    if (explicit !== undefined) return explicit;
    if (source !== undefined) return source;
    throw invalid("Artifact request requires instance or defaultInstance.");
}

export function readShareId(params?: JsonValue): string {
    if (!isRecord(params)) throw invalid("Artifact share request requires shareId.");
    return readRequiredString(params.shareId, "shareId");
}

export function readTransferId(params?: JsonValue): string {
    if (!isRecord(params)) throw invalid("Artifact transfer request requires transferId.");
    return readRequiredString(params.transferId, "transferId");
}

function readPositiveInteger(value: JsonValue | undefined, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw invalid(`${field} must be a positive integer.`);
    return value;
}

function readRequiredString(value: JsonValue | undefined, field: string): string {
    const result = readOptionalString(value, field);
    if (result === undefined) throw invalid(`${field} is required.`);
    return result;
}

function readOptionalString(value: JsonValue | undefined, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value.length === 0) throw invalid(`${field} must be a non-empty string.`);
    return value;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string) {
    return createError({ code: errorCodes.targetInvalid, message, retryable: false });
}

import { isAbsolute } from "node:path";

import type { ExtensionInvocationContext } from "@portable-devshell/extension";
import {
    createError,
    errorCodes,
    type ExtensionCommandWireResult,
    type ExtensionRemoveResult,
    type ExtensionRuntimeRecord,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../../route/ControlRouteFactory.js";

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
    command(
        commandId: string,
        argv: readonly string[],
        context: ExtensionInvocationContext
    ): Promise<ExtensionCommandWireResult>;
    enable(id: string): Promise<void>;
    install(sourcePath: string): Promise<ExtensionRuntimeRecord>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(id: string): Promise<void>;
    remove(id: string, purge: boolean): Promise<ExtensionRemoveResult>;
}

export function createExtensionRouteModule(port: ExtensionControlPort): PrefixRouteModuleDefinition {
    return routeModule("extension", {
        list: async () => await port.list() as unknown as JsonValue,
        get: async (request) => await requireRecord(port, readExtensionId(request.payload)) as unknown as JsonValue,
        command: async (request, context) => {
            requireCliCommand(context);
            const input = readCommand(request.payload);
            const localOwner = isLocalOwnerCli(context);
            if (input.workingDirectory !== undefined && !localOwner) {
                throw createError({
                    code: errorCodes.controlExtensionAccessDenied,
                    message: "Extension command workingDirectory is restricted to the local owner CLI.",
                    retryable: false
                });
            }
            return assertCommandResult(await port.command(
                input.commandId,
                input.argv,
                {
                    localOwner,
                    requestId: context.requestId,
                    signal: context.signal,
                    ...(input.workingDirectory === undefined ? {} : {
                        workingDirectory: input.workingDirectory
                    })
                }
            ), input.commandId) as unknown as JsonValue;
        },
        reload: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.reload(id);
            return await requireRecord(port, id) as unknown as JsonValue;
        },
        enable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.enable(id);
            return await requireRecord(port, id) as unknown as JsonValue;
        },
        disable: async (request, context) => {
            requireLocalManagement(context);
            const id = readExtensionId(request.payload);
            await port.disable(id);
            return await requireRecord(port, id) as unknown as JsonValue;
        },
        install: async (request, context) => {
            requireLocalManagement(context);
            return await port.install(readInstallSource(request.payload)) as unknown as JsonValue;
        },
        remove: async (request, context) => {
            requireLocalManagement(context);
            const input = readRemove(request.payload);
            return await port.remove(input.extensionId, input.purge) as unknown as JsonValue;
        }
    });
}

async function requireRecord(port: ExtensionControlPort, id: string): Promise<ExtensionRuntimeRecord> {
    const record = (await port.list()).find((candidate) => candidate.id === id);
    if (record !== undefined) return record;
    throw createError({
        code: errorCodes.controlExtensionNotFound,
        details: { extensionId: id },
        message: `Extension ${id} is not installed.`,
        retryable: false
    });
}

function requireLocalManagement(context: PrefixRouteContext): void {
    if (isLocalOwnerCli(context)) return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message: "Extension lifecycle mutations are restricted to the local owner CLI.",
        retryable: false
    });
}

function isLocalOwnerCli(context: PrefixRouteContext): boolean {
    return context.peer === "cli" && context.subject?.kind === "local-owner";
}

function requireCliCommand(context: PrefixRouteContext): void {
    if (context.peer === "cli") return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message: "Extension command dispatch is available only to CLI clients.",
        retryable: false
    });
}

function readCommand(payload: JsonValue | undefined): {
    argv: string[];
    commandId: string;
    workingDirectory?: string;
} {
    const value = readRecord(payload, "extension.command");
    assertOnlyKeys(value, ["argv", "commandId", "workingDirectory"], "extension.command");
    if (!Array.isArray(value.argv) || value.argv.some((candidate) => typeof candidate !== "string")) {
        throw invalid("extension.command argv must be an array of strings.");
    }
    if (
        value.workingDirectory !== undefined &&
        (typeof value.workingDirectory !== "string" || !isAbsolute(value.workingDirectory))
    ) {
        throw invalid("extension.command workingDirectory must be an absolute path.");
    }
    return {
        argv: [...value.argv] as string[],
        commandId: readId(value.commandId, "commandId"),
        ...(value.workingDirectory === undefined ? {} : { workingDirectory: value.workingDirectory })
    };
}

function readExtensionId(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "Extension request");
    assertOnlyKeys(value, ["extensionId"], "Extension request");
    return readId(value.extensionId, "extensionId");
}

function readInstallSource(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "extension.install");
    assertOnlyKeys(value, ["sourcePath"], "extension.install");
    if (typeof value.sourcePath === "string" && value.sourcePath.length > 0) return value.sourcePath;
    throw invalid("extension.install sourcePath must be a non-empty string.");
}

function readRemove(payload: JsonValue | undefined): { extensionId: string; purge: boolean } {
    const value = readRecord(payload, "extension.remove");
    assertOnlyKeys(value, ["extensionId", "purge"], "extension.remove");
    if (value.purge !== undefined && typeof value.purge !== "boolean") {
        throw invalid("extension.remove purge must be boolean.");
    }
    return {
        extensionId: readId(value.extensionId, "extensionId"),
        purge: value.purge === true
    };
}

function readId(value: JsonValue | undefined, label: "commandId" | "extensionId"): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value)) return value;
    throw invalid(`${label} must match [a-z][a-z0-9-]*.`);
}

function readRecord(payload: JsonValue | undefined, operation: string): Record<string, JsonValue> {
    if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) return payload;
    throw invalid(`${operation} requires an object payload.`);
}

function assertOnlyKeys(value: Record<string, JsonValue>, keys: readonly string[], operation: string): void {
    const allowed = new Set(keys);
    const unknown = Object.keys(value).find((key) => !allowed.has(key));
    if (unknown !== undefined) throw invalid(`${operation} contains unknown field ${unknown}.`);
}

function assertCommandResult(value: ExtensionCommandWireResult, commandId: string): ExtensionCommandWireResult {
    if (value.kind === "text" && typeof value.text === "string" && value.value === undefined) {
        return { kind: "text", text: value.text };
    }
    if (value.kind === "json" && value.text === undefined && value.value !== undefined) {
        return { kind: "json", value: assertJsonValue(value.value, `Extension command ${commandId} result`) };
    }
    throw createError({
        code: errorCodes.controlExtensionFailed,
        details: { commandId },
        message: `Extension command ${commandId} returned an invalid result.`,
        retryable: false
    });
}

function assertJsonValue(value: unknown, label: string): JsonValue {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (Array.isArray(value)) return value.map((candidate) => assertJsonValue(candidate, label));
    if (typeof value === "object" && value !== null) {
        const result: Record<string, JsonValue> = {};
        for (const [key, candidate] of Object.entries(value)) {
            if (candidate === undefined) {
                throw createError({
                    code: errorCodes.controlExtensionFailed,
                    message: `${label} is not JSON serializable.`,
                    retryable: false
                });
            }
            result[key] = assertJsonValue(candidate, label);
        }
        return result;
    }
    throw createError({
        code: errorCodes.controlExtensionFailed,
        message: `${label} is not JSON serializable.`,
        retryable: false
    });
}

function invalid(message: string): Error {
    return createError({
        code: errorCodes.controlExtensionInvalid,
        message,
        retryable: false
    });
}

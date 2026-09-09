import {
    createError,
    errorCodes,
    type ExtensionRemoveResult,
    type ExtensionRuntimeRecord,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../../route/ControlRouteFactory.js";

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
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

function readExtensionId(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "Extension request");
    assertOnlyKeys(value, ["extensionId"], "Extension request");
    return readExtensionIdValue(value.extensionId);
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
        extensionId: readExtensionIdValue(value.extensionId),
        purge: value.purge === true
    };
}

function readExtensionIdValue(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value)) return value;
    throw invalid("extensionId must match [a-z][a-z0-9-]*.");
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

function invalid(message: string): Error {
    return createError({
        code: errorCodes.controlExtensionInvalid,
        message,
        retryable: false
    });
}

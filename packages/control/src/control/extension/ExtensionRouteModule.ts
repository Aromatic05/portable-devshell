import {
    createError,
    errorCodes,
    type ExtensionCommandWireResult,
    type ExtensionRuntimeRecord,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface ExtensionControlPort {
    disable(id: string): Promise<void>;
    dispatchCommand(
        id: string,
        argv: readonly string[],
        context: { requestId: string; signal: AbortSignal }
    ): Promise<ExtensionCommandWireResult>;
    dispatchRpc(
        id: string,
        operation: string,
        input: JsonValue | undefined,
        context: { requestId: string; signal: AbortSignal }
    ): Promise<JsonValue>;
    enable(id: string): Promise<void>;
    list(): Promise<ExtensionRuntimeRecord[]>;
    reload(id: string): Promise<void>;
}

export function createExtensionRouteModule(port: ExtensionControlPort): PrefixRouteModuleDefinition {
    return routeModule("extension", {
        list: async () => await port.list() as unknown as JsonValue,
        get: async (request) => await requireRecord(port, readExtensionId(request.payload)) as unknown as JsonValue,
        call: async (request, context) => {
            const input = readCall(request.payload);
            const result = await port.dispatchRpc(
                input.extensionId,
                input.operation,
                input.input,
                { requestId: context.requestId, signal: context.signal }
            );
            return assertJsonValue(result, `Extension ${input.extensionId} RPC result`);
        },
        command: async (request, context) => {
            requireCliCommand(context);
            const input = readCommand(request.payload);
            return assertCommandResult(await port.dispatchCommand(
                input.extensionId,
                input.argv,
                { requestId: context.requestId, signal: context.signal }
            ), input.extensionId) as unknown as JsonValue;
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
    if (context.peer === "cli" && context.subject?.kind === "local-owner") return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message: "Extension lifecycle mutations are restricted to the local owner CLI.",
        retryable: false
    });
}

function requireCliCommand(context: PrefixRouteContext): void {
    if (context.peer === "cli") return;
    throw createError({
        code: errorCodes.controlExtensionAccessDenied,
        message: "Extension command dispatch is available only to CLI clients.",
        retryable: false
    });
}

function readCall(payload: JsonValue | undefined): {
    extensionId: string;
    input?: JsonValue;
    operation: string;
} {
    const value = readRecord(payload, "extension.call");
    assertOnlyKeys(value, ["extensionId", "input", "operation"], "extension.call");
    return {
        extensionId: readId(value.extensionId),
        ...(value.input === undefined ? {} : { input: value.input }),
        operation: readOperation(value.operation)
    };
}

function readCommand(payload: JsonValue | undefined): { argv: string[]; extensionId: string } {
    const value = readRecord(payload, "extension.command");
    assertOnlyKeys(value, ["argv", "extensionId"], "extension.command");
    if (!Array.isArray(value.argv) || value.argv.some((candidate) => typeof candidate !== "string")) {
        throw invalid("extension.command argv must be an array of strings.");
    }
    return { argv: [...value.argv] as string[], extensionId: readId(value.extensionId) };
}

function readExtensionId(payload: JsonValue | undefined): string {
    const value = readRecord(payload, "Extension request");
    assertOnlyKeys(value, ["extensionId"], "Extension request");
    return readId(value.extensionId);
}

function readId(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[a-z][a-z0-9-]*$/u.test(value)) return value;
    throw invalid("extensionId must match [a-z][a-z0-9-]*.");
}

function readOperation(value: JsonValue | undefined): string {
    if (typeof value === "string" && /^[A-Za-z][A-Za-z0-9]*$/u.test(value)) return value;
    throw invalid("Extension operation must be one route-safe identifier.");
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

function assertCommandResult(value: ExtensionCommandWireResult, extensionId: string): ExtensionCommandWireResult {
    if (value.kind === "text" && typeof value.text === "string" && value.value === undefined) {
        return { kind: "text", text: value.text };
    }
    if (value.kind === "json" && value.text === undefined && value.value !== undefined) {
        return { kind: "json", value: assertJsonValue(value.value, `Extension ${extensionId} command result`) };
    }
    throw createError({
        code: errorCodes.controlExtensionFailed,
        details: { extensionId },
        message: `Extension ${extensionId} returned an invalid command result.`,
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

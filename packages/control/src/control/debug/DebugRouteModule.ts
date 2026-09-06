import {
    createError,
    errorCodes,
    type DebugPatchLoadRequest,
    type DebugPatchSummary,
    type DebugTargetSummary,
    type JsonValue,
    type PrefixRouteContext,
    type PrefixRouteModuleDefinition,
} from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface DebugPatchPort {
    listPatches(): DebugPatchSummary[];
    listTargets(): DebugTargetSummary[];
    load(request: DebugPatchLoadRequest): Promise<DebugPatchSummary>;
    release(patchId: string): DebugPatchSummary;
    unload(patchId: string): Promise<DebugPatchSummary>;
}

export function createDebugRouteModule(port: DebugPatchPort): PrefixRouteModuleDefinition {
    return routeModule("debug", {
        list: (_request, context) => {
            requireLocalDebug(context);
            return port.listPatches() as unknown as JsonValue;
        },
        load: async (request, context) => {
            requireLocalDebug(context);
            return await port.load(readLoadRequest(request.payload)) as unknown as JsonValue;
        },
        release: (request, context) => {
            requireLocalDebug(context);
            return port.release(readPatchId(request.payload, "debug.release")) as unknown as JsonValue;
        },
        targets: (_request, context) => {
            requireLocalDebug(context);
            return port.listTargets() as unknown as JsonValue;
        },
        unload: async (request, context) => {
            requireLocalDebug(context);
            return await port.unload(readPatchId(request.payload, "debug.unload")) as unknown as JsonValue;
        },
    });
}

function requireLocalDebug(context: PrefixRouteContext): void {
    if (context.peer === "cli" && context.subject?.kind === "local-owner") return;
    throw createError({
        code: errorCodes.controlDebugAccessDenied,
        message: "Debug patch operations are restricted to the local owner CLI.",
        retryable: false,
    });
}

function readLoadRequest(payload: JsonValue | undefined): DebugPatchLoadRequest {
    const value = readRecord(payload, "debug.load");
    if (typeof value.target !== "string" || value.target.length === 0) {
        throw invalid("debug.load target must be a non-empty string.");
    }
    if (typeof value.source !== "string" || value.source.length === 0) {
        throw invalid("debug.load source must be a non-empty string.");
    }
    if (
        value.name !== undefined &&
        (typeof value.name !== "string" || value.name.length === 0)
    ) {
        throw invalid("debug.load name must be a non-empty string when supplied.");
    }
    return {
        ...(value.name === undefined ? {} : { name: value.name }),
        source: value.source,
        target: value.target,
    };
}

function readPatchId(payload: JsonValue | undefined, operation: string): string {
    const value = readRecord(payload, operation);
    if (typeof value.patchId !== "string" || value.patchId.length === 0) {
        throw invalid(`${operation} patchId must be a non-empty string.`);
    }
    return value.patchId;
}

function readRecord(
    payload: JsonValue | undefined,
    operation: string,
): Record<string, JsonValue> {
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
        throw invalid(`${operation} requires an object payload.`);
    }
    return payload;
}

function invalid(message: string) {
    return createError({
        code: errorCodes.controlDebugPatchInvalid,
        message,
        retryable: false,
    });
}

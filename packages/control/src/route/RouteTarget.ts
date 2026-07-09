import {
    createControlTarget,
    createError,
    createInstanceTarget,
    errorCodes,
    type ControlError,
    type ControlTarget as RouteTarget,
    type JsonValue
} from "@portable-devshell/shared";

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRouteTarget(value: JsonValue | undefined): RouteTarget {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw createTargetError();
    }

    if (value.kind === "control") {
        return createControlTarget();
    }

    if (value.kind === "instance" && typeof value.instance === "string" && value.instance.length > 0) {
        return createInstanceTarget(value.instance);
    }

    throw createTargetError();
}

function createTargetError(): ControlError {
    return createError({
        code: errorCodes.targetInvalid,
        message: "Request target is invalid.",
        retryable: false
    });
}

export type { RouteTarget };

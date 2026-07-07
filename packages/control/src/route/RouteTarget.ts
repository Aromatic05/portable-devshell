import { asInstanceName, createError, errorCodes, type ControlError, type JsonValue } from "@portable-devshell/shared";

export type RouteTarget =
    | {
          kind: "control";
      }
    | {
          instance: string;
          kind: "instance";
      };

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseRouteTarget(value: JsonValue | undefined): RouteTarget {
    if (!isRecord(value) || typeof value.kind !== "string") {
        throw createTargetError();
    }

    if (value.kind === "control") {
        return { kind: "control" };
    }

    if (value.kind === "instance" && typeof value.instance === "string" && value.instance.length > 0) {
        return {
            instance: asInstanceName(value.instance),
            kind: "instance"
        };
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

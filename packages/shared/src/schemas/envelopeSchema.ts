import type {
    ControlEnvelope,
    ControlEventEnvelope,
    ControlRequestEnvelope,
    ControlResponseEnvelope
} from "../protocol/ControlEnvelope.js";
import type { ControlMethod } from "../protocol/ControlMethods.js";
import type { ControlTarget } from "../protocol/ControlTarget.js";
import { asInstanceName } from "../types/InstanceName.js";

type ParseSuccess<T> = {
    data: T;
    success: true;
};

type ParseFailure = {
    error: Error;
    success: false;
};

type ParseResult<T> = ParseFailure | ParseSuccess<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTarget(value: unknown): ControlTarget {
    if (!isRecord(value) || typeof value.type !== "string") {
        throw new Error("target must be an object");
    }

    if (value.type === "controller") {
        return { type: "controller" };
    }

    if (value.type === "instance" && typeof value.instanceName === "string" && value.instanceName.length > 0) {
        return {
            instanceName: asInstanceName(value.instanceName),
            type: "instance"
        };
    }

    throw new Error("target is invalid");
}

function parseEnvelopeBase(value: Record<string, unknown>): { id: string; issuedAt: string } {
    if (typeof value.id !== "string" || value.id.length === 0) {
        throw new Error("envelope.id must be a non-empty string");
    }

    if (typeof value.issuedAt !== "string" || value.issuedAt.length === 0) {
        throw new Error("envelope.issuedAt must be a non-empty string");
    }

    return {
        id: value.id,
        issuedAt: value.issuedAt
    };
}

function parseRequestEnvelope(value: Record<string, unknown>): ControlRequestEnvelope {
    if (typeof value.method !== "string" || value.method.length === 0) {
        throw new Error("request.method must be a non-empty string");
    }

    return {
        ...parseEnvelopeBase(value),
        kind: "request",
        method: value.method as ControlMethod,
        params: value.params as ControlRequestEnvelope["params"],
        target: parseTarget(value.target)
    };
}

function parseResponseEnvelope(value: Record<string, unknown>): ControlResponseEnvelope {
    return {
        ...parseEnvelopeBase(value),
        error: value.error as ControlResponseEnvelope["error"],
        kind: "response",
        result: value.result as ControlResponseEnvelope["result"]
    };
}

function parseEventEnvelope(value: Record<string, unknown>): ControlEventEnvelope {
    if (typeof value.event !== "string" || value.event.length === 0) {
        throw new Error("event.event must be a non-empty string");
    }

    return {
        ...parseEnvelopeBase(value),
        event: value.event,
        kind: "event",
        payload: value.payload as ControlEventEnvelope["payload"],
        target: parseTarget(value.target)
    };
}

export const envelopeSchema = {
    parse(value: unknown): ControlEnvelope {
        if (!isRecord(value) || typeof value.kind !== "string") {
            throw new Error("envelope must be an object");
        }

        switch (value.kind) {
            case "event":
                return parseEventEnvelope(value);
            case "request":
                return parseRequestEnvelope(value);
            case "response":
                return parseResponseEnvelope(value);
            default:
                throw new Error("envelope.kind is invalid");
        }
    },
    safeParse(value: unknown): ParseResult<ControlEnvelope> {
        try {
            return {
                data: this.parse(value),
                success: true
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error : new Error(String(error)),
                success: false
            };
        }
    }
};

import type {
    ControlEnvelope,
    ControlEventEnvelope,
    ControlRequestEnvelope,
    ControlResponseEnvelope
} from "../protocol/envelope/ProtocolEnvelopeControl.js";
import type { ControlMethod } from "../protocol/method/ProtocolMethodControl.js";
import {
    createControlTarget,
    createInstanceTarget,
    type ControlTarget,
    type ControlTargetInstance
} from "../protocol/envelope/ProtocolEnvelopeTarget.js";

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

function assertMissingLegacyField(value: Record<string, unknown>, fieldName: string): void {
    if (fieldName in value) {
        throw new Error(`legacy field ${fieldName} is not supported`);
    }
}

function parseTarget(value: unknown): ControlTarget {
    if (!isRecord(value)) {
        throw new Error("target must be an object");
    }

    assertMissingLegacyField(value, "type");
    assertMissingLegacyField(value, "instanceName");

    if (typeof value.kind !== "string") {
        throw new Error("target.kind must be a non-empty string");
    }

    if (value.kind === "control") {
        return createControlTarget();
    }

    if (value.kind === "instance" && typeof value.instance === "string" && value.instance.length > 0) {
        return createInstanceTarget(value.instance);
    }

    throw new Error("target is invalid");
}

function parseInstanceTarget(value: unknown): ControlTargetInstance {
    const target = parseTarget(value);

    if (target.kind !== "instance") {
        throw new Error("event.target must be an instance target");
    }

    return target;
}

function parseEnvelopeId(value: Record<string, unknown>): { id: string } {
    if (typeof value.id !== "string" || value.id.length === 0) {
        throw new Error("envelope.id must be a non-empty string");
    }

    return {
        id: value.id
    };
}

function parseRequestEnvelope(value: Record<string, unknown>): ControlRequestEnvelope {
    assertMissingLegacyField(value, "kind");
    assertMissingLegacyField(value, "issuedAt");

    if (typeof value.method !== "string" || value.method.length === 0) {
        throw new Error("request.method must be a non-empty string");
    }

    return {
        ...parseEnvelopeId(value),
        method: value.method as ControlMethod,
        params: value.params as ControlRequestEnvelope["params"],
        target: parseTarget(value.target),
        type: "request"
    };
}

function parseResponseEnvelope(value: Record<string, unknown>): ControlResponseEnvelope {
    assertMissingLegacyField(value, "kind");
    assertMissingLegacyField(value, "issuedAt");

    if (typeof value.ok !== "boolean") {
        throw new Error("response.ok must be a boolean");
    }

    return {
        ...parseEnvelopeId(value),
        error: value.error as ControlResponseEnvelope["error"],
        ok: value.ok,
        result: value.result as ControlResponseEnvelope["result"],
        type: "response"
    };
}

function parseEventEnvelope(value: Record<string, unknown>): ControlEventEnvelope {
    assertMissingLegacyField(value, "kind");
    assertMissingLegacyField(value, "id");
    assertMissingLegacyField(value, "issuedAt");

    if (typeof value.event !== "string" || value.event.length === 0) {
        throw new Error("event.event must be a non-empty string");
    }

    if (typeof value.seq !== "number") {
        throw new Error("event.seq must be a number");
    }

    return {
        event: value.event,
        payload: value.payload as ControlEventEnvelope["payload"],
        seq: value.seq,
        target: parseInstanceTarget(value.target),
        type: "event"
    };
}

export const envelopeSchema = {
    parse(value: unknown): ControlEnvelope {
        if (!isRecord(value) || typeof value.type !== "string") {
            throw new Error("envelope must be an object");
        }

        switch (value.type) {
            case "event":
                return parseEventEnvelope(value);
            case "request":
                return parseRequestEnvelope(value);
            case "response":
                return parseResponseEnvelope(value);
            default:
                throw new Error("envelope.type is invalid");
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

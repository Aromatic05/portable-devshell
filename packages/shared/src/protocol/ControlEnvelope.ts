import type { ControlErrorBody } from "../errors/ControlError.js";
import type { JsonValue } from "../types/JsonValue.js";
import type { ControlMethod } from "./ControlMethods.js";
import type { ControlTarget } from "./ControlTarget.js";

interface ControlEnvelopeBase {
    id: string;
    issuedAt: string;
}

export interface ControlRequestEnvelope extends ControlEnvelopeBase {
    kind: "request";
    method: ControlMethod;
    params?: JsonValue;
    target: ControlTarget;
}

export interface ControlResponseEnvelope extends ControlEnvelopeBase {
    error?: ControlErrorBody;
    kind: "response";
    result?: JsonValue;
}

export interface ControlEventEnvelope extends ControlEnvelopeBase {
    event: string;
    kind: "event";
    payload?: JsonValue;
    target: ControlTarget;
}

export type ControlEnvelope =
    | ControlEventEnvelope
    | ControlRequestEnvelope
    | ControlResponseEnvelope;

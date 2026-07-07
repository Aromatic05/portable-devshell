import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { ControlMethod } from "../method/ProtocolMethodControl.js";
import type { ControlTarget } from "./ProtocolEnvelopeTarget.js";

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

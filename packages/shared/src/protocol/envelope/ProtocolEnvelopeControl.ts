import type { ControlErrorBody } from "../../error/ErrorBodyControl.js";
import type { JsonValue } from "../../type/TypeJsonValue.js";
import type { ControlMethod } from "../method/ProtocolMethodControl.js";
import type { ControlTarget, ControlTargetInstance } from "./ProtocolEnvelopeTarget.js";

interface ControlEnvelopeWithId {
    id: string;
}

export interface ControlRequestEnvelope extends ControlEnvelopeWithId {
    method: ControlMethod;
    params?: JsonValue;
    target: ControlTarget;
    type: "request";
}

export interface ControlResponseEnvelope extends ControlEnvelopeWithId {
    error?: ControlErrorBody;
    ok: boolean;
    result?: JsonValue;
    type: "response";
}

export interface ControlEventEnvelope {
    event: string;
    payload?: JsonValue;
    seq: number;
    target: ControlTargetInstance;
    type: "event";
}

export type ControlEnvelope =
    | ControlEventEnvelope
    | ControlRequestEnvelope
    | ControlResponseEnvelope;

export interface ControlRelayInputEnvelope extends ControlEnvelopeWithId {
    data?: string;
    eof?: boolean;
    type: "relay.input";
}

export interface ControlRelayOutputEnvelope extends ControlEnvelopeWithId {
    data: string;
    type: "relay.output";
}

export interface ControlStreamGapPayload extends Record<string, JsonValue> {
    instance: string;
    latestSeq: number;
    oldestAvailableSeq: number;
    requestedFromSeq: number;
}

export interface ControlStreamCancelledPayload extends Record<string, JsonValue> {
    instance: string;
    reason: string;
}

export interface ControlStreamGapEnvelope extends ControlEventEnvelope {
    event: "stream.gap";
    payload: ControlStreamGapPayload;
    target: ControlTargetInstance;
}

export interface ControlStreamCancelledEnvelope extends ControlEventEnvelope {
    event: "stream.cancelled";
    payload: ControlStreamCancelledPayload;
    target: ControlTargetInstance;
}

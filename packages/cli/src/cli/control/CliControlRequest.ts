import type { ControlErrorBody, JsonValue } from "@portable-devshell/shared";

export type CliControlTarget =
    | {
          kind: "control";
      }
    | {
          instance: string;
          kind: "instance";
      };

export interface CliControlRequestEnvelope {
    id: string;
    issuedAt: string;
    method: string;
    params?: JsonValue;
    target: CliControlTarget;
    type: "request";
}

export interface CliControlResponseEnvelope {
    error?: ControlErrorBody;
    id: string;
    ok: boolean;
    result?: JsonValue;
    type: "response";
}

export interface CliControlEventTarget {
    instance: string;
    kind: "instance";
}

export interface CliControlInstanceEventEnvelope {
    event: string;
    payload?: JsonValue;
    seq: number;
    target: CliControlEventTarget;
    type: "event";
}

export interface CliControlStreamGapPayload {
    instance: string;
    latestSeq: number;
    oldestAvailableSeq: number;
    requestedFromSeq: number;
}

export interface CliControlStreamGapEnvelope {
    event: "stream.gap";
    payload: CliControlStreamGapPayload;
    seq: number;
    target: CliControlEventTarget;
    type: "event";
}

export interface CliControlStreamCancelledPayload {
    instance: string;
    reason: string;
}

export interface CliControlStreamCancelledEnvelope {
    event: "stream.cancelled";
    payload: CliControlStreamCancelledPayload;
    seq: number;
    target: CliControlEventTarget;
    type: "event";
}

export type CliControlEventEnvelope =
    | CliControlInstanceEventEnvelope
    | CliControlStreamGapEnvelope
    | CliControlStreamCancelledEnvelope;

export interface CliControlRelayInputEnvelope {
    data?: string;
    eof?: boolean;
    id: string;
    type: "relay.input";
}

export interface CliControlRelayOutputEnvelope {
    data: string;
    id: string;
    type: "relay.output";
}

export function createControlTarget(): CliControlTarget {
    return { kind: "control" };
}

export function createInstanceTarget(instance: string): CliControlTarget {
    return {
        instance,
        kind: "instance"
    };
}

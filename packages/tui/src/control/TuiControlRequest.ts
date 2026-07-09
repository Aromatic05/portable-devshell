import type { ControlErrorBody, JsonValue } from "@portable-devshell/shared";

export type TuiControlTarget =
    | {
          kind: "control";
      }
    | {
          instance: string;
          kind: "instance";
      };

export interface TuiControlResponseEnvelope {
    error?: ControlErrorBody;
    id: string;
    ok: boolean;
    result?: JsonValue;
    type: "response";
}

export interface TuiControlEventTarget {
    instance: string;
    kind: "instance";
}

export interface TuiControlInstanceEventEnvelope {
    event: string;
    payload?: JsonValue;
    seq: number;
    target: TuiControlEventTarget;
    type: "event";
}

export interface TuiControlStreamGapPayload {
    instance: string;
    latestSeq: number;
    oldestAvailableSeq: number;
    requestedFromSeq: number;
}

export interface TuiControlStreamGapEnvelope {
    event: "stream.gap";
    payload: TuiControlStreamGapPayload;
    seq: number;
    target: TuiControlEventTarget;
    type: "event";
}

export interface TuiControlStreamCancelledPayload {
    instance: string;
    reason: string;
}

export interface TuiControlStreamCancelledEnvelope {
    event: "stream.cancelled";
    payload: TuiControlStreamCancelledPayload;
    seq: number;
    target: TuiControlEventTarget;
    type: "event";
}

export type TuiControlEventEnvelope =
    | TuiControlInstanceEventEnvelope
    | TuiControlStreamGapEnvelope
    | TuiControlStreamCancelledEnvelope;

export function createControlTarget(): TuiControlTarget {
    return { kind: "control" };
}

export function createInstanceTarget(instance: string): TuiControlTarget {
    return {
        instance,
        kind: "instance"
    };
}

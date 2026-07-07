import type { JsonValue } from "@portable-devshell/shared";

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
    error?: {
        code: string;
        details?: JsonValue;
        message: string;
        retryable: boolean;
    };
    id: string;
    ok: boolean;
    result?: JsonValue;
    type: "response";
}

export interface CliControlEventEnvelope {
    event: string;
    payload?: JsonValue;
    seq: number;
    target: {
        instance: string;
        kind: "instance";
    };
    type: "event";
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

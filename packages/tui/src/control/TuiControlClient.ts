import {
    asInstanceName,
    type ApprovalDecision,
    type ApprovalRequest,
    type CommandResult,
    type ControlEventEnvelope,
    type InstanceSnapshot,
    type JsonValue,
    type ToolCallQuery,
    type ToolCallRecord
} from "@portable-devshell/shared";

import {
    createSubscribedStream,
    TuiControlConnection,
    type TuiControlConnectionOptions
} from "./TuiControlConnection.js";
import { createControlTarget, createInstanceTarget } from "./TuiControlRequest.js";
import type { TuiControlStream } from "./TuiControlStream.js";

export interface TuiControlSnapshotEnvelope {
    lastSeq: number;
    snapshot: InstanceSnapshot;
}

export interface TuiControlListInstanceEntry {
    mcpEnabled: boolean;
    name: string;
    snapshot?: InstanceSnapshot;
}

export interface TuiControlLogEntry {
    at: string;
    instanceName: string;
    message: string;
    seq: number;
    stream: "stderr" | "stdout";
}

export interface TuiControlStartOptions {
    relay?: {
        onOutput(chunk: string): void;
        onRequestId?(requestId: string): void;
    };
    workspacePath?: string;
}

export interface TuiControlDecisionOptions {
    policyPatch?: JsonValue;
    reason?: string;
    remember?: boolean;
}

export interface TuiControlClientLike {
    getConfigView(): Promise<Record<string, JsonValue>>;
    getApproval(instance: string, approvalId: string): Promise<ApprovalRequest>;
    getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope>;
    listApprovals(instance: string): Promise<ApprovalRequest[]>;
    listInstances(): Promise<TuiControlListInstanceEntry[]>;
    ping(): Promise<{ pong: boolean }>;
    readLogs(instance: string, params?: { fromSeq?: number; limit?: number }): Promise<TuiControlLogEntry[]>;
    readToolCalls(instance: string, params?: ToolCallQuery): Promise<ToolCallRecord[]>;
    refreshStatus(instance: string): Promise<TuiControlSnapshotEnvelope>;
    startInstance(instance: string, options?: TuiControlStartOptions): Promise<InstanceSnapshot>;
    stopInstance(instance: string): Promise<InstanceSnapshot>;
    callTool(instance: string, toolName: string, input: JsonValue): Promise<CommandResult>;
    decideApproval(
        instance: string,
        approvalId: string,
        decision: ApprovalDecision["decision"],
        options?: TuiControlDecisionOptions
    ): Promise<ApprovalRequest>;
    subscribe(instance: string, fromSeq: number): Promise<TuiControlStream>;
}

export class TuiControlClient implements TuiControlClientLike {
    readonly #connectionOptions: TuiControlConnectionOptions;

    constructor(options: TuiControlConnectionOptions = {}) {
        this.#connectionOptions = options;
    }

    async ping(): Promise<{ pong: boolean }> {
        return (await this.#request("control.ping", createControlTarget())) as unknown as { pong: boolean };
    }

    async listInstances(): Promise<TuiControlListInstanceEntry[]> {
        return (await this.#request("control.listInstances", createControlTarget())) as unknown as TuiControlListInstanceEntry[];
    }

    async getConfigView(): Promise<Record<string, JsonValue>> {
        return (await this.#request("control.getConfigView", createControlTarget())) as unknown as Record<string, JsonValue>;
    }

    async getSnapshot(instance: string): Promise<TuiControlSnapshotEnvelope> {
        return (await this.#request("instance.getSnapshot", createInstanceTarget(instance))) as unknown as TuiControlSnapshotEnvelope;
    }

    async refreshStatus(instance: string): Promise<TuiControlSnapshotEnvelope> {
        return (await this.#request("instance.refreshStatus", createInstanceTarget(instance))) as unknown as TuiControlSnapshotEnvelope;
    }

    async startInstance(instance: string, options: TuiControlStartOptions = {}): Promise<InstanceSnapshot> {
        const params = options.workspacePath === undefined ? undefined : { workspacePath: options.workspacePath };

        if (options.relay === undefined) {
            return (await this.#request("instance.start", createInstanceTarget(instance), params)) as unknown as InstanceSnapshot;
        }

        const connection = new TuiControlConnection(this.#connectionOptions);

        try {
            return (await connection.requestWithRelay("instance.start", createInstanceTarget(instance), options.relay, params)) as unknown as InstanceSnapshot;
        } finally {
            connection.close();
        }
    }

    async stopInstance(instance: string): Promise<InstanceSnapshot> {
        return (await this.#request("instance.stop", createInstanceTarget(instance))) as unknown as InstanceSnapshot;
    }

    async readLogs(instance: string, params?: { fromSeq?: number; limit?: number }): Promise<TuiControlLogEntry[]> {
        return (await this.#request("instance.readLogs", createInstanceTarget(instance), params as unknown as JsonValue)) as unknown as TuiControlLogEntry[];
    }

    async readToolCalls(instance: string, params?: ToolCallQuery): Promise<ToolCallRecord[]> {
        return (await this.#request("instance.readToolCalls", createInstanceTarget(instance), params as unknown as JsonValue)) as unknown as ToolCallRecord[];
    }

    async listApprovals(instance: string): Promise<ApprovalRequest[]> {
        return (await this.#request("instance.listApprovals", createInstanceTarget(instance))) as unknown as ApprovalRequest[];
    }

    async getApproval(instance: string, approvalId: string): Promise<ApprovalRequest> {
        return (await this.#request("instance.getApproval", createInstanceTarget(instance), { approvalId })) as unknown as ApprovalRequest;
    }

    async decideApproval(
        instance: string,
        approvalId: string,
        decision: ApprovalDecision["decision"],
        options: TuiControlDecisionOptions = {}
    ): Promise<ApprovalRequest> {
        return (await this.#request("instance.decideApproval", createInstanceTarget(instance), {
            approvalId,
            decision,
            ...options
        })) as unknown as ApprovalRequest;
    }

    async callTool(instance: string, toolName: string, input: JsonValue): Promise<CommandResult> {
        return (await this.#request("instance.callTool", createInstanceTarget(instance), {
            input,
            toolName
        })) as unknown as CommandResult;
    }

    async subscribe(instance: string, fromSeq: number): Promise<TuiControlStream> {
        const connection = new TuiControlConnection(this.#connectionOptions);
        const result = (await connection.request("instance.subscribe", createInstanceTarget(instance), {
            fromSeq
        })) as unknown as {
            events: ControlEventEnvelope[] | JsonValue[];
            lastSeq: number;
        };

        return createSubscribedStream(connection, result.events.map((event) => normalizeInitialEvent(instance, event as JsonValue)));
    }

    async #request(method: string, target: ReturnType<typeof createControlTarget> | ReturnType<typeof createInstanceTarget>, params?: JsonValue): Promise<JsonValue> {
        const connection = new TuiControlConnection(this.#connectionOptions);

        try {
            return await connection.request(method, target, params);
        } finally {
            connection.close();
        }
    }
}

function normalizeInitialEvent(instance: string, value: JsonValue): ControlEventEnvelope {
    if (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.type === "string" &&
        typeof value.seq === "number"
    ) {
        return {
            event: value.type,
            payload: value,
            seq: value.seq,
            target: {
                instance: asInstanceName(instance),
                kind: "instance"
            },
            type: "event"
        };
    }

    return {
        event: "stream.cancelled",
        payload: {
            instance,
            reason: "invalid.initialEvent"
        },
        seq: 0,
        target: {
            instance: asInstanceName(instance),
            kind: "instance"
        },
        type: "event"
    };
}

import {
    STREAM_GAP_CODE,
    type ApprovalDecision,
    type ApprovalRequest,
    type InstanceEventRecord,
    type InstanceName,
    type InstanceSnapshot,
    type JsonValue,
} from "@portable-devshell/shared";

export interface InstanceEventInput {
    at: string;
    data?: JsonValue;
    type: string;
}

export interface InstanceEventStreamGap {
    code: typeof STREAM_GAP_CODE;
    fromSeq: number;
    kind: "gap";
    lastSeq: number;
    nextSeq: number;
}

export interface InstanceEventStreamSlice {
    events: InstanceEventRecord[];
    kind: "events";
    lastSeq: number;
}

export interface InstanceEventSource {
    cursor(): number;
    subscribe(
        fromSeq?: number,
    ): InstanceEventStreamGap | InstanceEventStreamSlice;
}

export class InstanceEventBuffer {
    readonly #instanceName: InstanceName;
    readonly #capacity: number;
    #appendTail: Promise<void> = Promise.resolve();
    #events: InstanceEventRecord[] = [];
    #lastSeq = 0;

    constructor(
        instanceName: InstanceName,
        capacity: number,
    ) {
        this.#instanceName = instanceName;
        this.#capacity = capacity;
    }

    get lastSeq(): number {
        return this.#lastSeq;
    }

    cursor(): number {
        return this.#lastSeq;
    }

    async append(event: InstanceEventInput): Promise<InstanceEventRecord> {
        const operation = this.#appendTail.then(async () => {
            const storedEvent: InstanceEventRecord = {
                at: event.at,
                data: event.data,
                instanceName: this.#instanceName,
                seq: this.#lastSeq + 1,
                type: event.type,
            };
            this.#lastSeq = storedEvent.seq;
            this.#events.push(storedEvent);
            if (this.#events.length > this.#capacity) this.#events.shift();
            return storedEvent;
        });
        this.#appendTail = operation.then(
            () => undefined,
            () => undefined,
        );
        return await operation;
    }

    subscribe(
        fromSeq = 1,
    ): InstanceEventStreamGap | InstanceEventStreamSlice {
        return this.readFrom(fromSeq);
    }

    readFrom(fromSeq = 1): InstanceEventStreamGap | InstanceEventStreamSlice {
        const nextSeq = this.#events[0]?.seq ?? this.#lastSeq + 1;
        if (fromSeq < nextSeq) {
            return {
                code: STREAM_GAP_CODE,
                fromSeq,
                kind: "gap",
                lastSeq: this.#lastSeq,
                nextSeq,
            };
        }
        return {
            events: this.#events.filter((event) => event.seq >= fromSeq),
            kind: "events",
            lastSeq: this.#lastSeq,
        };
    }

}

export function toEventData(
    record: Record<string, JsonValue | undefined>,
): Record<string, JsonValue> {
    return Object.fromEntries(
        Object.entries(record).filter(([, value]) => value !== undefined),
    ) as Record<string, JsonValue>;
}

export function toApprovalEventData(
    request: ApprovalRequest,
    decision?: ApprovalDecision,
): Record<string, JsonValue> {
    return toEventData({
        approvalId: request.approvalId,
        callId: request.callId,
        createdAt: request.createdAt,
        decidedAt: decision?.decidedAt,
        decidedBy: decision?.decidedBy,
        decision: decision?.decision,
        expiresAt: request.expiresAt,
        inputSummary: request.inputSummary,
        reason: decision?.reason ?? request.reason,
        recording: request.recording,
        requestId: request.requestId,
        remember: decision?.remember,
        riskLevel: request.riskLevel,
        ctxId: request.ctxId,
        extensionId: request.extensionId,
        source: request.source,
        status: request.status,
        toolName: request.toolName,
        workspace: request.workspace,
    });
}

export function createStatusChangedEventData(
    previous: InstanceSnapshot,
    next: InstanceSnapshot,
): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        lastErrorMessage: next.lastErrorMessage,
        pid: next.pid,
        previousDaemonState: previous.daemonState,
        previousStatus: previous.status,
        ready: next.ready,
        status: next.status,
    });
}

export function createConnectionChangedEventData(
    previous: InstanceSnapshot,
    next: InstanceSnapshot,
): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        lastErrorMessage: next.lastErrorMessage,
        pid: next.pid,
        previousConnectionState: previous.connectionState,
        ready: next.ready,
        status: next.status,
    });
}

export function createReadyChangedEventData(
    previous: InstanceSnapshot,
    next: InstanceSnapshot,
): Record<string, JsonValue> {
    return toEventData({
        connectionState: next.connectionState,
        daemonState: next.daemonState,
        lastErrorCode: next.lastErrorCode,
        lastErrorMessage: next.lastErrorMessage,
        pid: next.pid,
        previousReady: previous.ready,
        ready: next.ready,
        status: next.status,
    });
}

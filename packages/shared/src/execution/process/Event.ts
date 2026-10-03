import {
    type EventStreamEnvelope,
    type EventStreamPort,
    EventStreamReader,
    EventSubscription,
    readStreamGap,
    readStreamGapPayload,
    type StreamGap,
    type StreamMessage,
    type SubscriptionStatus,
} from "../../client/Stream.js";
import { type MessageStream } from "../../transport/packet/Stream.js";
import { type InstanceName } from "../../types/Instance.js";
import { type JsonValue } from "../../types/Json.js";
import { type ToolCallSource } from "../tool/Model.js";

export type InstanceEventType =
    | "instance.started"
    | "instance.stopped"
    | "instance.statusChanged"
    | "instance.connectionChanged"
    | "instance.readyChanged"
    | "worker.transportConnected"
    | "worker.transportDisconnected"
    | "worker.schemaRefreshed"
    | "worker.protocolIntegrityFault"
    | "reverse.connected"
    | "reverse.disconnected"
    | "reverse.enrollmentChanged"
    | "reverse.transportChanged"
    | "toolCall.queued"
    | "toolCall.started"
    | "toolCall.running"
    | "toolCall.completed"
    | "toolCall.failed"
    | "toolCall.denied"
    | "toolCall.queueTimeout"
    | "toolCall.cancelled"
    | "log.appended"
    | "mcp.sessionOpened"
    | "mcp.sessionClosed"
    | "mcp.toolCalled"
    | "approval.requested"
    | "approval.approved"
    | "approval.denied"
    | "approval.expired"
    | "approval.cancelled"
    | "context.message.queued"
    | "context.message.delivered"
    | "context.message.failed"
    | "goal.updated"
    | "todo.created"
    | "todo.updated"
    | "todo.completed"
    | "todo.archived"
    | "todo.deleted"
    | "wait.created"
    | "wait.detached"
    | "wait.reattached"
    | "wait.resolved"
    | "wait.recoveryClaimed"
    | "wait.recoveryDismissed"
    | "wait.recoveryMessageAttempted"
    | "wait.recoveryReleased"
    | "wait.consumed"
    | "wait.cancelled";
export interface InstanceEvent {
    at: string;
    data?: JsonValue;
    instanceName: InstanceName;
    seq: number;
    type: InstanceEventType;
}
export interface InstanceLogEntry {
    at: string;
    callId?: string;
    ctxId?: string;
    instanceName: string;
    message: string;
    requestId?: string;
    seq: number;
    source?: ToolCallSource;
    stream: "stderr" | "stdout";
    toolName?: string;
}
export interface InstanceLogQuery {
    fromSeq?: number;
    limit?: number;
    maxDecodedBytes?: number;
}
export type InstanceStreamEnvelope = EventStreamEnvelope;
export type InstanceStreamMessage = StreamMessage<InstanceEvent>;
export type InstanceEventStreamPort = EventStreamPort<InstanceEvent>;
/**
 * Anything that can open the instance-wide, cursor-resumable event stream.
 * ProcessTransport satisfies this; domains without a server-filtered stream
 * (approval) consume the shared stream and filter events client-side so the
 * subscription cursor still tracks the global instance sequence.
 */
export interface InstanceEventSource {
    subscribe(
        instance: string,
        fromSeq: number,
    ): Promise<InstanceEventStreamPort>;
}
const readInstanceStreamGap = readStreamGap;
const readInstanceStreamGapPayload = readStreamGapPayload;
function readInstanceEvent(value: JsonValue | undefined): InstanceEvent {
    const event = record(value);
    if (
        event === undefined ||
        typeof event.at !== "string" ||
        typeof event.instanceName !== "string" ||
        typeof event.seq !== "number" ||
        typeof event.type !== "string"
    )
        throw new Error("Invalid instance event.");
    return {
        at: event.at,
        ...(event.data === undefined ? {} : { data: event.data }),
        instanceName: event.instanceName as InstanceEvent["instanceName"],
        seq: event.seq,
        type: event.type as InstanceEvent["type"],
    };
}
function record(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
export class InstanceEventStream extends EventStreamReader<InstanceEvent> {
    constructor(instance: InstanceName, stream: MessageStream) {
        super(stream, {
            decodeEvent: (payload) => {
                const event = readInstanceEvent(payload);
                if (event.instanceName !== instance)
                    throw new Error("Subscription contains another instance.");
                return event;
            },
            readGap: readInstanceStreamGapPayload,
        });
    }
}
export type InstanceEventSubscriptionStatus = SubscriptionStatus;
export interface InstanceEventSubscriptionOptions {
    onEvent(event: InstanceEvent): void;
    /**
     * Recover from a gap and return the sequence to resume from. Return
     * undefined to let the subscription retry with backoff.
     */
    onGap(gap: StreamGap): Promise<number | undefined> | number | undefined;
    onStatusChange?(status: InstanceEventSubscriptionStatus): void;
    open(fromSeq: number): Promise<InstanceEventStreamPort>;
    retryBaseMs?: number;
    retryMaxMs?: number;
}
export class InstanceEventSubscription extends EventSubscription<InstanceEvent> {
    constructor(fromSeq: number, options: InstanceEventSubscriptionOptions) {
        super(fromSeq, {
            ...options,
            eventSeq: (event) => event.seq,
            readGapError: readInstanceStreamGap,
        });
    }
}

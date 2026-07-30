import {
    ClientConnection, controlClientModule, instanceClientModule, readClientSubscriptionEvents,
    type ApprovalDecisionValue, type ApprovalRequest, type ClientConnectionOptions, type ClientEvent,
    type ClientStream, type InstanceEvent, type InstanceListEntry, type InstanceLogEntry,
    type InstanceRuntimeEnvelope, type InstanceSnapshot, type OAuthApprovalDecision, type OAuthApprovalRequest
} from "@portable-devshell/shared";
import { BrowserWebSocketChannelProvider } from "../rpc/BrowserWebSocketChannelProvider.js";

export interface WebClients {
    close(): void; reconnect(): Promise<void>;
    service: { status(): Promise<{ instanceCount: number; ok: boolean; pid?: number }> };
    instance: { list(): Promise<InstanceListEntry[]> };
    runtime: { snapshot(instance: string): Promise<InstanceRuntimeEnvelope>; refresh(instance: string): Promise<InstanceRuntimeEnvelope>; readLogs(instance: string, query?: { fromSeq?: number; limit?: number }): Promise<InstanceLogEntry[]>; stop(instance: string): Promise<InstanceSnapshot>; start(instance: string): Promise<InstanceSnapshot>; subscribe(instance: string, fromSeq: number): Promise<WebRuntimeStream> };
    tool: { listApprovals(instance: string): Promise<ApprovalRequest[]>; getApproval(instance: string, approvalId: string): Promise<ApprovalRequest>; decideApproval(instance: string, approvalId: string, decision: ApprovalDecisionValue): Promise<ApprovalRequest> };
    mcp: { listApprovals(): Promise<OAuthApprovalRequest[]>; decideApproval(approvalId: string, decision: OAuthApprovalDecision): Promise<OAuthApprovalRequest> };
}

export class WebRuntimeStream {
    #initial: ClientEvent[];
    constructor(private readonly stream: ClientStream, acknowledgement: ClientEvent, instance: string) { this.#initial = readClientSubscriptionEvents(instance as never, acknowledgement.payload); }
    async next(): Promise<{ kind: "event"; event: InstanceEvent } | { kind: "gap" } | { kind: "closed" }> {
        const event = this.#initial.shift() ?? await this.stream.nextEvent();
        if (event.name === "stream.gap") return { kind: "gap" };
        if (event.name === "stream.completed" || event.name === "stream.cancelled") return { kind: "closed" };
        return { kind: "event", event: event.payload as unknown as InstanceEvent };
    }
    close(): void { this.stream.close(); }
}

export function createWebClients(options: Partial<ClientConnectionOptions> = {}): WebClients {
    const connection = new ClientConnection({ channelProvider: new BrowserWebSocketChannelProvider(), mode: "persistent", peer: "web", mapError, mapRemoteError: mapError, ...options });
    const service = controlClientModule(connection, "service"); const instance = controlClientModule(connection, "instance"); const mcp = controlClientModule(connection, "mcp"); const runtime = instanceClientModule(connection, "runtime"); const tool = instanceClientModule(connection, "tool");
    return {
        close: () => connection.close(), reconnect: () => connection.reconnect(),
        service: { status: () => service.request("status") }, instance: { list: () => instance.request("list") },
        runtime: {
            snapshot: (name) => runtime.request(name, "snapshot"), refresh: (name) => runtime.request(name, "refresh"), readLogs: (name, query) => runtime.request(name, "readLogs", query), stop: (name) => runtime.request(name, "stop"),
            start: async (name) => { const opened = await runtime.openStream(name, "start"); while (true) { const event = await opened.stream.nextEvent(); if (event.name === "stream.completed") return event.payload as unknown as InstanceSnapshot; if (event.name === "stream.cancelled") { connection.throwRemoteError(event.error); throw new Error("Start cancelled."); } } },
            subscribe: async (name, fromSeq) => { const opened = await runtime.openStream(name, "subscribe", { fromSeq }); return new WebRuntimeStream(opened.stream, opened.acknowledgement, name); }
        },
        tool: { listApprovals: (name) => tool.request(name, "listApprovals"), getApproval: (name, approvalId) => tool.request(name, "getApproval", { approvalId }), decideApproval: (name, approvalId, decision) => tool.request(name, "decideApproval", { approvalId, decision }) },
        mcp: { listApprovals: () => mcp.request("listApprovals"), decideApproval: (approvalId, decision) => mcp.request("decideApproval", { approvalId, decision }) }
    };
}
function mapError(error: unknown): Error { return error instanceof Error ? error : new Error(String(error)); }

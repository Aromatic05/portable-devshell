import type { ApprovalRequest, InstanceEvent, InstanceListEntry, InstanceLogEntry, OAuthApprovalRequest } from "@portable-devshell/shared";
import type { WebClients, WebRuntimeStream } from "../client/WebClients.js";

export type ConnectionState = "connecting" | "online" | "offline";
export interface WebState { connection: ConnectionState; error?: string; service?: { instanceCount: number; ok: boolean; pid?: number }; instances: InstanceListEntry[]; approvals: Record<string, ApprovalRequest[]>; oauthApprovals: OAuthApprovalRequest[]; logs: Record<string, InstanceLogEntry[]>; activity: InstanceEvent[]; }
const initial: WebState = { connection: "connecting", instances: [], approvals: {}, oauthApprovals: [], logs: {}, activity: [] };
export class WebStore {
    #state = initial; #listeners = new Set<() => void>(); #streams = new Map<string, WebRuntimeStream>(); #stopped = false;
    constructor(readonly clients: WebClients) {}
    get state(): WebState { return this.#state; }
    subscribe(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
    async load(): Promise<void> {
        this.set({ ...this.#state, connection: "connecting", error: undefined });
        try {
            const [service, instances, oauthApprovals] = await Promise.all([this.clients.service.status(), this.clients.instance.list(), this.clients.mcp.listApprovals()]);
            const approvals = Object.fromEntries(await Promise.all(instances.map(async ({ name }) => [name, await this.clients.tool.listApprovals(name)])));
            this.set({ ...this.#state, connection: "online", service, instances, oauthApprovals, approvals });
            await Promise.all(instances.map(({ name, snapshot }) => this.beginSubscription(name, snapshot.lastSeq)));
        } catch (error) { this.set({ ...this.#state, connection: "offline", error: message(error) }); }
    }
    async reconnect(): Promise<void> { this.closeStreams(); try { await this.clients.reconnect(); await this.load(); } catch (error) { this.set({ ...this.#state, connection: "offline", error: message(error) }); } }
    async refreshInstance(name: string): Promise<void> { const [envelope, logs, approvals] = await Promise.all([this.clients.runtime.refresh(name), this.clients.runtime.readLogs(name, { limit: 50 }), this.clients.tool.listApprovals(name)]); this.set({ ...this.#state, instances: this.#state.instances.map((entry) => entry.name === name ? { ...entry, snapshot: envelope.snapshot } : entry), logs: { ...this.#state.logs, [name]: logs.slice(-100) }, approvals: { ...this.#state.approvals, [name]: approvals } }); }
    async decideTool(instance: string, approvalId: string, decision: "approve" | "deny"): Promise<void> { await this.clients.tool.decideApproval(instance, approvalId, decision); await this.refreshInstance(instance); }
    async decideOAuth(approvalId: string, decision: "approve" | "deny"): Promise<void> { await this.clients.mcp.decideApproval(approvalId, decision); this.set({ ...this.#state, oauthApprovals: await this.clients.mcp.listApprovals() }); }
    async start(instance: string): Promise<void> { await this.clients.runtime.start(instance); await this.refreshInstance(instance); }
    async stop(instance: string): Promise<void> { await this.clients.runtime.stop(instance); await this.refreshInstance(instance); }
    close(): void { this.#stopped = true; this.closeStreams(); this.clients.close(); }
    private async beginSubscription(name: string, fromSeq: number): Promise<void> { if (this.#stopped) return; this.#streams.get(name)?.close(); try { const stream = await this.clients.runtime.subscribe(name, fromSeq); this.#streams.set(name, stream); void this.consume(name, stream); } catch (error) { this.set({ ...this.#state, connection: "offline", error: message(error) }); } }
    private async consume(name: string, stream: WebRuntimeStream): Promise<void> { while (!this.#stopped && this.#streams.get(name) === stream) { try { const message = await stream.next(); if (message.kind === "gap") { await this.refreshInstance(name); await this.beginSubscription(name, this.#state.instances.find((entry) => entry.name === name)?.snapshot.lastSeq ?? 0); return; } if (message.kind === "closed") { this.set({ ...this.#state, connection: "offline" }); return; } this.addEvent(name, message.event); } catch (error) { this.set({ ...this.#state, connection: "offline", error: message(error) }); return; } } }
    private addEvent(name: string, event: InstanceEvent): void { const activity = [...this.#state.activity, event].sort((a, b) => a.at.localeCompare(b.at)).slice(-200); this.set({ ...this.#state, activity, instances: this.#state.instances.map((entry) => entry.name === name ? { ...entry, snapshot: { ...entry.snapshot, lastSeq: Math.max(entry.snapshot.lastSeq, event.seq) } } : entry) }); if (event.type === "log.appended") void this.refreshInstance(name); if (event.type.startsWith("approval.")) void this.refreshApprovals(name); }
    private async refreshApprovals(name: string): Promise<void> { this.set({ ...this.#state, approvals: { ...this.#state.approvals, [name]: await this.clients.tool.listApprovals(name) } }); }
    private closeStreams(): void { for (const stream of this.#streams.values()) stream.close(); this.#streams.clear(); }
    private set(state: WebState): void { this.#state = state; for (const listener of this.#listeners) listener(); }
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }

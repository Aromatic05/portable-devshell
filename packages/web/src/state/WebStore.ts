import {
    CONTROL_PROTOCOL_VERSION,
    type ApprovalRequest,
    type InstanceEvent,
    type InstanceListEntry,
    type InstanceLogEntry,
    type OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

import type { WebClients, WebRuntimeStream } from "../client/WebClients.js";

export type ConnectionState = "connecting" | "online" | "offline";

export interface WebState {
    connection: ConnectionState;
    error?: string;
    service?: { instanceCount: number; ok: boolean; pid?: number };
    instances: InstanceListEntry[];
    approvals: Record<string, ApprovalRequest[]>;
    oauthApprovals: OAuthApprovalRequest[];
    logs: Record<string, InstanceLogEntry[]>;
    activity: InstanceEvent[];
}

const initial: WebState = {
    connection: "connecting",
    instances: [],
    approvals: {},
    oauthApprovals: [],
    logs: {},
    activity: [],
};

export class WebStore {
    #state = initial;
    #listeners = new Set<() => void>();
    #streams = new Map<string, WebRuntimeStream>();
    #logRefreshes = new Map<string, ReturnType<typeof setTimeout>>();
    #stopped = false;
    #loadPromise?: Promise<void>;
    #reconnectPromise?: Promise<void>;

    constructor(readonly clients: WebClients) {}

    get state(): WebState {
        return this.#state;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    async load(): Promise<void> {
        if (this.#loadPromise !== undefined) {
            return await this.#loadPromise;
        }
        this.#loadPromise = this.loadCurrent().finally(() => {
            this.#loadPromise = undefined;
        });
        return await this.#loadPromise;
    }

    async reconnect(): Promise<void> {
        if (this.#reconnectPromise !== undefined) {
            return await this.#reconnectPromise;
        }
        this.#reconnectPromise = this.reconnectCurrent().finally(() => {
            this.#reconnectPromise = undefined;
        });
        return await this.#reconnectPromise;
    }

    async refreshInstance(name: string): Promise<void> {
        try {
            const [envelope, logs, approvals] = await Promise.all([
                this.clients.runtime.refresh(name),
                this.clients.runtime.readLogs(name, { limit: 50 }),
                this.clients.tool.listApprovals(name),
            ]);
            this.set({
                ...this.#state,
                instances: this.#state.instances.map((entry) =>
                    entry.name === name
                        ? { ...entry, snapshot: envelope.snapshot }
                        : entry,
                ),
                logs: { ...this.#state.logs, [name]: logs.slice(-100) },
                approvals: { ...this.#state.approvals, [name]: approvals },
            });
        } catch (error) {
            this.setError(error);
        }
    }

    async decideTool(
        instance: string,
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(async () => {
            await this.clients.tool.decideApproval(
                instance,
                approvalId,
                decision,
            );
            await this.refreshInstance(instance);
        });
    }

    async decideOAuth(
        approvalId: string,
        decision: "approve" | "deny",
    ): Promise<void> {
        await this.mutate(async () => {
            await this.clients.mcp.decideApproval(approvalId, decision);
            this.set({
                ...this.#state,
                oauthApprovals: await this.clients.mcp.listApprovals(),
            });
        });
    }

    async start(instance: string): Promise<void> {
        await this.mutate(async () => {
            await this.clients.runtime.start(instance);
            await this.refreshInstance(instance);
        });
    }

    async stop(instance: string): Promise<void> {
        await this.mutate(async () => {
            await this.clients.runtime.stop(instance);
            await this.refreshInstance(instance);
        });
    }

    close(): void {
        if (this.#stopped) {
            return;
        }
        this.#stopped = true;
        this.closeStreams();
        for (const timeout of this.#logRefreshes.values()) {
            clearTimeout(timeout);
        }
        this.#logRefreshes.clear();
        this.clients.close();
    }

    private async loadCurrent(): Promise<void> {
        this.set({
            ...this.#state,
            connection: "connecting",
            error: undefined,
        });
        try {
            const hello = await this.clients.service.hello();
            if (hello.protocolVersion !== CONTROL_PROTOCOL_VERSION) {
                throw new Error(
                    `Incompatible control protocol version: ${hello.protocolVersion}.`,
                );
            }
            const [service, instances, mcpStatus] = await Promise.all([
                this.clients.service.status(),
                this.clients.instance.list(),
                this.clients.mcp.status(),
            ]);
            const oauthApprovals =
                mcpStatus.authMode === "oauth2" && mcpStatus.oauthReady === true
                    ? await this.clients.mcp.listApprovals()
                    : [];
            const approvals = Object.fromEntries(
                await Promise.all(
                    instances.map(async ({ name }) => [
                        name,
                        await this.clients.tool.listApprovals(name),
                    ]),
                ),
            );
            this.set({
                ...this.#state,
                connection: "online",
                service,
                instances,
                oauthApprovals,
                approvals,
            });
            await Promise.all(
                instances.map(({ name, snapshot }) =>
                    this.beginSubscription(name, snapshot.lastSeq),
                ),
            );
        } catch (error) {
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async reconnectCurrent(): Promise<void> {
        this.closeStreams();
        try {
            await this.clients.reconnect();
            await this.load();
        } catch (error) {
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async beginSubscription(
        name: string,
        fromSeq: number,
    ): Promise<void> {
        if (this.#stopped) {
            return;
        }
        this.#streams.get(name)?.close();
        try {
            const stream = await this.clients.runtime.subscribe(name, fromSeq);
            if (this.#stopped) {
                stream.close();
                return;
            }
            this.#streams.set(name, stream);
            void this.consume(name, stream);
        } catch (error) {
            this.set({
                ...this.#state,
                connection: "offline",
                error: message(error),
            });
        }
    }

    private async consume(
        name: string,
        stream: WebRuntimeStream,
    ): Promise<void> {
        while (!this.#stopped && this.#streams.get(name) === stream) {
            try {
                const event = await stream.next();
                if (event.kind === "gap") {
                    await this.refreshInstance(name);
                    const lastSeq =
                        this.#state.instances.find(
                            (entry) => entry.name === name,
                        )?.snapshot.lastSeq ?? 0;
                    await this.beginSubscription(name, lastSeq);
                    return;
                }
                if (event.kind === "closed") {
                    this.set({ ...this.#state, connection: "offline" });
                    return;
                }
                this.addEvent(name, event.event);
            } catch (error) {
                this.set({
                    ...this.#state,
                    connection: "offline",
                    error: message(error),
                });
                return;
            }
        }
    }

    private addEvent(name: string, event: InstanceEvent): void {
        const activity = [...this.#state.activity, event]
            .sort((left, right) => left.at.localeCompare(right.at))
            .slice(-200);
        this.set({
            ...this.#state,
            activity,
            instances: this.#state.instances.map((entry) =>
                entry.name === name
                    ? {
                          ...entry,
                          snapshot: {
                              ...entry.snapshot,
                              lastSeq: Math.max(
                                  entry.snapshot.lastSeq,
                                  event.seq,
                              ),
                          },
                      }
                    : entry,
            ),
        });
        if (event.type === "log.appended") {
            this.scheduleLogRefresh(name);
        }
        if (event.type.startsWith("approval.")) {
            void this.refreshApprovals(name);
        }
    }

    private scheduleLogRefresh(name: string): void {
        if (this.#logRefreshes.has(name)) {
            return;
        }
        const timeout = setTimeout(() => {
            this.#logRefreshes.delete(name);
            void this.readLogs(name);
        }, 250);
        this.#logRefreshes.set(name, timeout);
    }

    private async readLogs(name: string): Promise<void> {
        try {
            const logs = await this.clients.runtime.readLogs(name, {
                limit: 50,
            });
            this.set({
                ...this.#state,
                logs: { ...this.#state.logs, [name]: logs.slice(-100) },
            });
        } catch (error) {
            this.setError(error);
        }
    }

    private async refreshApprovals(name: string): Promise<void> {
        try {
            const approvals = await this.clients.tool.listApprovals(name);
            this.set({
                ...this.#state,
                approvals: { ...this.#state.approvals, [name]: approvals },
            });
        } catch (error) {
            this.setError(error);
        }
    }

    private async mutate(action: () => Promise<void>): Promise<void> {
        try {
            await action();
        } catch (error) {
            this.setError(error);
        }
    }

    private closeStreams(): void {
        for (const stream of this.#streams.values()) {
            stream.close();
        }
        this.#streams.clear();
    }

    private setError(error: unknown): void {
        this.set({ ...this.#state, error: message(error) });
    }

    private set(state: WebState): void {
        this.#state = state;
        for (const listener of this.#listeners) {
            listener();
        }
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

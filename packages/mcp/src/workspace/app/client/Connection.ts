import type { WorkspaceActionRequest, WorkspaceActionResult, WorkspaceHostModelContext, WorkspaceSnapshot } from "../../model/Contract.js";
import type { WorkspaceSession } from "./Session.js";

export interface WorkspaceToolResult { structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean; }
export interface WorkspaceToolCaller { callServerTool(request: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<WorkspaceToolResult>; }
export interface WorkspaceConnectionFence { ctxId: string; generation: number; }
export interface WorkspaceReentryDelivery { message: string; modelContext: WorkspaceHostModelContext; }
export interface WorkspaceReentryResponse { claimed?: boolean; valid?: boolean; attempted?: boolean; duplicate?: boolean; delivery?: WorkspaceReentryDelivery; }

export class WorkspaceConnection {
    readonly #session: WorkspaceSession;
    readonly #app: WorkspaceToolCaller;
    readonly #fetch: typeof fetch;
    #cursor = 0;
    #liveRetryAt = 0;
    #disabled = false;
    #disabledError: unknown;
    readonly #disabledListeners = new Set<(error: unknown) => void>();
    constructor(session: WorkspaceSession, app: WorkspaceToolCaller, fetcher: typeof fetch = fetch) {
        this.#session = session;
        this.#app = app;
        this.#fetch = fetcher;
        session.onContextChange(() => {
            this.#cursor = 0;
            this.#liveRetryAt = 0;
        });
    }
    get cursor(): number { return this.#cursor; }
    get disabled(): boolean { return this.#disabled; }
    onDisabled(listener: (error: unknown) => void): () => void {
        this.#disabledListeners.add(listener);
        return () => this.#disabledListeners.delete(listener);
    }
    fence(): WorkspaceConnectionFence { return { ctxId: this.#session.state.ctxId, generation: this.#session.generation }; }
    assertCurrent(fence: WorkspaceConnectionFence): void {
        if (!this.#session.isCurrent(fence.generation, fence.ctxId)) throw new Error("Workspace Context changed during request");
    }
    acceptSnapshot(snapshot: WorkspaceSnapshot): void {
        if (snapshot.ctxId !== this.#session.state.ctxId) return;
        this.#cursor = Math.max(this.#cursor, snapshot.cursor);
    }
    snapshot(signal?: AbortSignal): Promise<WorkspaceSnapshot> { return this.#read("/snapshot", "workspace_snapshot", {}, signal); }
    async watch(signal?: AbortSignal): Promise<{ snapshot?: WorkspaceSnapshot; cursor?: number }> {
        const result = await this.#read<{ snapshot?: WorkspaceSnapshot; cursor?: number }>("/watch?cursor=" + encodeURIComponent(String(this.#cursor)), "workspace_watch", { cursor: this.#cursor }, signal);
        if (typeof result.cursor === "number" && Number.isSafeInteger(result.cursor)) this.#cursor = Math.max(this.#cursor, result.cursor);
        return result;
    }
    async action(request: WorkspaceActionRequest, signal?: AbortSignal): Promise<WorkspaceActionResult> {
        const result = await this.#tool("workspace_action", request as unknown as Record<string, unknown>, signal);
        const value = result.structuredContent ?? result;
        if (!isRecord(value) || (value.status !== "applied" && value.status !== "stale") || !isRecord(value.snapshot)) throw new Error("workspace_action returned an invalid result");
        return value as unknown as WorkspaceActionResult;
    }
    async reentry(args: Record<string, unknown>, signal?: AbortSignal, fence?: WorkspaceConnectionFence): Promise<WorkspaceReentryResponse> { const result = await this.#tool("workspace_reentry", args, signal, fence); return (result.structuredContent ?? result) as WorkspaceReentryResponse; }
    async reconnect(signal?: AbortSignal): Promise<WorkspaceSnapshot> { const result = await this.#tool("workspace_reconnect", {}, signal); return (result.structuredContent ?? result) as WorkspaceSnapshot; }

    async #read<T>(path: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        this.#assertAvailable();
        const state = this.#session.state;
        const generation = this.#session.generation;
        if (!state.ctxId) throw new Error("Workspace context is unavailable");
        if (state.liveBaseUrl && state.token && Date.now() >= this.#liveRetryAt) {
            try {
                const separator = path.includes("?") ? "&" : "?";
                const timeoutSignal = AbortSignal.timeout(tool === "workspace_watch" ? 30_000 : 5_000);
                const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
                const response = await this.#fetch(state.liveBaseUrl + path + separator + "ctxId=" + encodeURIComponent(state.ctxId), { cache: "no-store", credentials: "omit", headers: { Authorization: "Bearer " + state.token }, signal: requestSignal });
                this.#assertAvailable();
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("Workspace request became stale");
                if (!response.ok) throw new Error("Live Workspace returned HTTP " + response.status);
                const result = await response.json() as T & { cursor?: number };
                this.#assertAvailable();
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("Workspace request became stale");
                this.#session.establishAuthorization(generation, state.ctxId);
                if (Number.isSafeInteger(result.cursor)) this.#cursor = Math.max(this.#cursor, result.cursor!);
                return result;
            } catch (error) {
                this.#assertAvailable();
                if (signal?.aborted) throw error;
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("Workspace Context changed during request");
                this.#liveRetryAt = Date.now() + 30_000;
                this.#session.suspendLiveEndpoint(generation, state.ctxId);
            }
        }
        const result = await this.#tool(tool, args, signal);
        return (result.structuredContent ?? result) as T;
    }

    async #tool(name: string, args: Record<string, unknown>, signal?: AbortSignal, fence?: WorkspaceConnectionFence): Promise<WorkspaceToolResult> {
        this.#assertAvailable();
        const { ctxId, token } = this.#session.state;
        const generation = this.#session.generation;
        if (!ctxId) throw new Error("Workspace context is unavailable");
        if (fence) this.assertCurrent(fence);
        const requestCtxId = fence?.ctxId ?? ctxId;
        let result: WorkspaceToolResult;
        try {
            result = await this.#app.callServerTool({ name, arguments: { ...args, ctxId: requestCtxId, ...(token ? { token } : {}) } }, { timeout: 30_000, signal });
        } catch (error) {
            if (!this.#disabled && this.#session.isCurrent(generation, ctxId) && isRecord(error) && error.code === -32601) {
                this.#disabled = true;
                this.#disabledError = error;
                for (const listener of this.#disabledListeners) listener(error);
            }
            throw error;
        }
        this.#assertAvailable();
        if (fence) this.assertCurrent(fence);
        if (!this.#session.isCurrent(generation, ctxId)) throw new Error("Workspace Context changed during request");
        if (result.isError === true) throw new Error("Workspace tool request failed");
        this.#session.establishAuthorization(generation, ctxId);
        return result;
    }

    #assertAvailable(): void { if (this.#disabled) throw this.#disabledError; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

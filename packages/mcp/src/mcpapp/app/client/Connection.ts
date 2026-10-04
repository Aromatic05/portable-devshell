import type { McpAppActionRequest, McpAppActionResult, McpAppHostModelContext, McpAppSnapshot } from "../../model/Contract.js";
import type { McpAppSession } from "./Session.js";

export interface McpAppToolResult { structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean; }
export interface McpAppToolCaller { callServerTool(request: { name: string; arguments: Record<string, unknown> }, options?: { timeout?: number; signal?: AbortSignal }): Promise<McpAppToolResult>; }
export interface McpAppConnectionFence { ctxId: string; generation: number; }
export interface McpAppReentryDelivery { message: string; modelContext: McpAppHostModelContext; }
export interface McpAppReentryResponse { claimed?: boolean; valid?: boolean; attempted?: boolean; duplicate?: boolean; delivery?: McpAppReentryDelivery; }

export class McpAppConnection {
    readonly #session: McpAppSession;
    readonly #app: McpAppToolCaller;
    readonly #fetch: typeof fetch;
    #cursor = 0;
    #liveRetryAt = 0;
    #disabled = false;
    #disabledError: unknown;
    readonly #disabledListeners = new Set<(error: unknown) => void>();
    constructor(session: McpAppSession, app: McpAppToolCaller, fetcher: typeof fetch = fetch) {
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
    fence(): McpAppConnectionFence { return { ctxId: this.#session.state.ctxId, generation: this.#session.generation }; }
    assertCurrent(fence: McpAppConnectionFence): void {
        if (!this.#session.isCurrent(fence.generation, fence.ctxId)) throw new Error("McpApp Context changed during request");
    }
    acceptSnapshot(snapshot: McpAppSnapshot): void {
        if (snapshot.ctxId !== this.#session.state.ctxId) return;
        this.#cursor = Math.max(this.#cursor, snapshot.cursor);
    }
    snapshot(signal?: AbortSignal): Promise<McpAppSnapshot> { return this.#read("/snapshot", "mcpapp_snapshot", {}, signal); }
    async watch(signal?: AbortSignal): Promise<{ snapshot?: McpAppSnapshot; cursor?: number }> {
        const result = await this.#read<{ snapshot?: McpAppSnapshot; cursor?: number }>("/watch?cursor=" + encodeURIComponent(String(this.#cursor)), "mcpapp_watch", { cursor: this.#cursor }, signal);
        if (typeof result.cursor === "number" && Number.isSafeInteger(result.cursor)) this.#cursor = Math.max(this.#cursor, result.cursor);
        return result;
    }
    async action(request: McpAppActionRequest, signal?: AbortSignal): Promise<McpAppActionResult> {
        const result = await this.#tool("mcpapp_action", request as unknown as Record<string, unknown>, signal);
        const value = result.structuredContent ?? result;
        if (!isRecord(value) || (value.status !== "applied" && value.status !== "stale") || !isRecord(value.snapshot)) throw new Error("mcpapp_action returned an invalid result");
        return value as unknown as McpAppActionResult;
    }
    async reentry(args: Record<string, unknown>, signal?: AbortSignal, fence?: McpAppConnectionFence): Promise<McpAppReentryResponse> { const result = await this.#tool("mcpapp_reentry", args, signal, fence); return (result.structuredContent ?? result) as McpAppReentryResponse; }
    async reconnect(signal?: AbortSignal): Promise<McpAppSnapshot> { const result = await this.#tool("mcpapp_reconnect", {}, signal); return (result.structuredContent ?? result) as McpAppSnapshot; }

    async #read<T>(path: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        this.#assertAvailable();
        const state = this.#session.state;
        const generation = this.#session.generation;
        if (!state.ctxId) throw new Error("McpApp context is unavailable");
        if (state.liveBaseUrl && state.token && Date.now() >= this.#liveRetryAt) {
            try {
                const separator = path.includes("?") ? "&" : "?";
                const timeoutSignal = AbortSignal.timeout(tool === "mcpapp_watch" ? 30_000 : 5_000);
                const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
                const response = await this.#fetch(state.liveBaseUrl + path + separator + "ctxId=" + encodeURIComponent(state.ctxId), { cache: "no-store", credentials: "omit", headers: { Authorization: "Bearer " + state.token }, signal: requestSignal });
                this.#assertAvailable();
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("McpApp request became stale");
                if (!response.ok) throw new Error("MCP App returned HTTP " + response.status);
                const result = await response.json() as T & { cursor?: number };
                this.#assertAvailable();
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("McpApp request became stale");
                this.#session.establishAuthorization(generation, state.ctxId);
                if (Number.isSafeInteger(result.cursor)) this.#cursor = Math.max(this.#cursor, result.cursor!);
                return result;
            } catch (error) {
                this.#assertAvailable();
                if (signal?.aborted) throw error;
                if (!this.#session.isCurrent(generation, state.ctxId)) throw new Error("McpApp Context changed during request");
                this.#liveRetryAt = Date.now() + 30_000;
                this.#session.suspendLiveEndpoint(generation, state.ctxId);
            }
        }
        const result = await this.#tool(tool, args, signal);
        return (result.structuredContent ?? result) as T;
    }

    async #tool(name: string, args: Record<string, unknown>, signal?: AbortSignal, fence?: McpAppConnectionFence): Promise<McpAppToolResult> {
        this.#assertAvailable();
        const { ctxId, token } = this.#session.state;
        const generation = this.#session.generation;
        if (!ctxId) throw new Error("McpApp context is unavailable");
        if (fence) this.assertCurrent(fence);
        const requestCtxId = fence?.ctxId ?? ctxId;
        let result: McpAppToolResult;
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
        if (!this.#session.isCurrent(generation, ctxId)) throw new Error("McpApp Context changed during request");
        if (result.isError === true) throw new Error("McpApp tool request failed");
        this.#session.establishAuthorization(generation, ctxId);
        return result;
    }

    #assertAvailable(): void { if (this.#disabled) throw this.#disabledError; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }

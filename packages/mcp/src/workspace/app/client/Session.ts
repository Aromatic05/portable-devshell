export interface WorkspaceSessionState { ctxId: string; token: string; liveBaseUrl: string; }

export class WorkspaceSession {
    #state: WorkspaceSessionState = { ctxId: "", token: "", liveBaseUrl: "" };
    #generation = 0;
    #authorizationEstablished = false;
    #authoritativeContext = false;
    #suspendedLiveBaseUrl = "";
    readonly #contextListeners = new Set<(ctxId: string) => void>();
    get state(): Readonly<WorkspaceSessionState> { return this.#state; }
    get generation(): number { return this.#generation; }

    configure(ctxId: string, capability?: unknown, authoritative = false): boolean {
        if (!ctxId) return false;
        if (this.#state.ctxId && this.#state.ctxId !== ctxId && (this.#authorizationEstablished || this.#authoritativeContext) && !authoritative) return false;
        const meta = asRecord(capability);
        const previousCtxId = this.#state.ctxId;
        const next = {
            ctxId,
            token: typeof meta?.token === "string" ? meta.token : this.#state.ctxId === ctxId ? this.#state.token : "",
            liveBaseUrl: typeof meta?.liveBaseUrl === "string" ? meta.liveBaseUrl : this.#state.ctxId === ctxId ? this.#state.liveBaseUrl : "",
        };
        if (JSON.stringify(next) !== JSON.stringify(this.#state)) {
            if (next.ctxId !== previousCtxId || next.liveBaseUrl !== this.#state.liveBaseUrl) this.#suspendedLiveBaseUrl = "";
            this.#generation += 1;
            if (next.ctxId !== previousCtxId) {
                this.#authorizationEstablished = false;
                this.#authoritativeContext = authoritative;
            }
        }
        if (authoritative) this.#authoritativeContext = true;
        this.#state = next;
        if (next.ctxId !== previousCtxId) for (const listener of this.#contextListeners) listener(next.ctxId);
        this.#persist();
        return true;
    }

    acceptToolResult(result: unknown): boolean {
        const record = asRecord(result);
        const structured = asRecord(record?.structuredContent);
        if (typeof structured?.ctxId !== "string") return false;
        const metadata = asRecord(record?._meta);
        return this.configure(structured.ctxId, metadata?.["portable-devshell/workspace"], true);
    }

    acceptGlobals(globals: unknown): boolean {
        const source = asRecord(globals);
        const metadata = asRecord(source?.toolResponseMetadata);
        const output = asRecord(source?.toolOutput);
        const envelope = asRecord(metadata?.mcp_tool_result) ?? asRecord(metadata?.call_tool_result);
        const ctxId = typeof output?.ctxId === "string" ? output.ctxId : "";
        const capability = asRecord(envelope?._meta)?.["portable-devshell/workspace"] ?? metadata?.["portable-devshell/workspace"];
        const widgetState = asRecord(source?.widgetState);
        const privateContent = asRecord(widgetState?.privateContent);
        const hint = asRecord(privateContent?.portableDevshellWorkspace) ?? asRecord(widgetState?.portableDevshellWorkspace);
        const accepted = this.configure(ctxId || (typeof hint?.ctxId === "string" ? hint.ctxId : ""), capability ?? hint);
        return accepted;
    }

    isCurrent(generation: number, ctxId: string): boolean { return generation === this.#generation && ctxId === this.#state.ctxId; }

    establishAuthorization(generation: number, ctxId: string): void {
        if (this.isCurrent(generation, ctxId)) this.#authorizationEstablished = true;
    }

    suspendLiveEndpoint(generation: number, ctxId: string): void {
        if (!this.isCurrent(generation, ctxId)) return;
        this.#suspendedLiveBaseUrl = this.#state.liveBaseUrl;
        this.#persist();
    }

    onContextChange(listener: (ctxId: string) => void): () => void {
        this.#contextListeners.add(listener);
        return () => this.#contextListeners.delete(listener);
    }

    #persist(): void {
        if (typeof window === "undefined") return;
        const openai = (window as Window & { openai?: { widgetState?: Record<string, unknown>; setWidgetState?: (state: unknown) => void } }).openai;
        if (!openai?.setWidgetState) return;
        const current = openai.widgetState ?? {};
        const privateContent = { ...(asRecord(current.privateContent) ?? {}) };
        const value = { ctxId: this.#state.ctxId, ...(this.#state.token ? { token: this.#state.token } : {}), ...(this.#state.liveBaseUrl && this.#state.liveBaseUrl !== this.#suspendedLiveBaseUrl ? { liveBaseUrl: this.#state.liveBaseUrl } : {}) };
        if (JSON.stringify(privateContent.portableDevshellWorkspace) === JSON.stringify(value)) return;
        privateContent.portableDevshellWorkspace = value;
        openai.setWidgetState({ modelContent: current.modelContent ?? null, privateContent, imageIds: Array.isArray(current.imageIds) ? current.imageIds : [] });
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }

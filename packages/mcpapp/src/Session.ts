export interface McpAppSession {
    ctxId: string;
    token: string;
    liveBaseUrl: string;
}

export function readMcpAppSession(result: unknown): McpAppSession | undefined {
    const envelope = record(result);
    const metadata = record(envelope?._meta);
    const capability = record(metadata?.["portable-devshell/mcpapp"]);
    if (typeof capability?.ctxId !== "string" || !capability.ctxId ||
        typeof capability.token !== "string" || capability.token.length < 16 ||
        typeof capability.liveBaseUrl !== "string") return undefined;
    let url: URL;
    try { url = new URL(capability.liveBaseUrl); } catch { return undefined; }
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
        return undefined;
    return { ctxId: capability.ctxId, token: capability.token, liveBaseUrl: url.href.replace(/\/+$/u, "") };
}

export function restoreMcpAppSession(): McpAppSession | undefined {
    const openai = (window as Window & { openai?: { widgetState?: { privateContent?: unknown } } }).openai;
    return readMcpAppSession({ _meta: { "portable-devshell/mcpapp": record(openai?.widgetState?.privateContent)?.portableDevshellMcpApp } });
}

export function saveMcpAppSession(session: McpAppSession): void {
    const openai = (window as Window & { openai?: {
        widgetState?: Record<string, unknown>;
        setWidgetState?: (state: unknown) => void;
    } }).openai;
    if (!openai?.setWidgetState) return;
    const current = openai.widgetState ?? {};
    const privateContent = record(current.privateContent) ?? {};
    openai.setWidgetState({
        modelContent: current.modelContent ?? null,
        privateContent: { ...privateContent, portableDevshellMcpApp: session },
        imageIds: Array.isArray(current.imageIds) ? current.imageIds : [],
    });
}

export function clearMcpAppSession(): void {
    const openai = (window as Window & { openai?: {
        widgetState?: Record<string, unknown>;
        setWidgetState?: (state: unknown) => void;
    } }).openai;
    if (!openai?.setWidgetState) return;
    const current = openai.widgetState ?? {};
    const { portableDevshellMcpApp: _capability, ...privateContent } = record(current.privateContent) ?? {};
    openai.setWidgetState({
        modelContent: current.modelContent ?? null,
        privateContent,
        imageIds: Array.isArray(current.imageIds) ? current.imageIds : [],
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

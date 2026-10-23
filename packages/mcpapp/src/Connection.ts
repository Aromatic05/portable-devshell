import type { McpAppSession } from "./Session.js";

export interface McpAppItem {
    id: string;
    title: string;
    badge?: string;
    summary?: string;
    detail?: string;
    current?: string;
    note?: string;
    progress?: { current: number; total: number };
    actions?: Array<{
        id: string;
        label: string;
        expectedRevision?: number;
        tone?: "default" | "primary" | "danger";
        confirmation?: { message: string };
    }>;
}
export interface McpAppSnapshot {
    ctxId: string;
    instance: string;
    cursor: number;
    agentBusy: boolean;
    activity?: Array<{
        callId: string;
        name: string;
        state: string;
        at: string;
        exitCode?: number;
        purpose?: string;
        target?: string;
        taskId?: string;
        summary?: string;
        detail?: string;
        input?: unknown;
        output?: unknown;
    }>;
    presentation: { primary?: McpAppItem; pendingApprovals?: number; work: McpAppItem[]; background: McpAppItem[] };
    reentry?: {
        pending?: boolean;
        schedule?: { readyAt: string; intent: "automatic"; sourceId?: string };
        directives?: Array<{ kind: "reentry"; id?: string; intent: "goal-resume" | "goal-retry" | "automatic"; sourceId?: string }>;
    };
}

export interface McpAppActivityOutput {
    callId: string;
    stdout: string;
    stderr: string;
    nextSeq?: number;
}

export interface McpAppActivityImage {
    src: string;
    mediaType: string;
}

/** Fetch a persisted image only when its audited Activity card is expanded. */
export async function readMcpAppActivityImage(
    session: McpAppSession, callId: string, signal: AbortSignal,
): Promise<McpAppActivityImage> {
    const image = record(await request(session,
        `/image?callId=${encodeURIComponent(callId)}`, signal));
    const mediaType = image?.mediaType;
    const content = image?.content;
    const bytes = image?.bytes;
    if (typeof mediaType !== "string" ||
        !/^(image\/png|image\/jpeg|image\/gif|image\/webp)$/u.test(mediaType) ||
        image?.encoding !== "base64" || typeof content !== "string" ||
        content.length === 0 || content.length > 14_000_000 ||
        content.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(content) ||
        typeof bytes !== "number" || !Number.isSafeInteger(bytes) ||
        bytes < 1 || bytes > 10 * 1024 * 1024)
        throw new Error("Invalid MCP App Activity image");
    return { src: `data:${mediaType};base64,${content}`, mediaType };
}

export async function readMcpAppActivityOutput(
    session: McpAppSession, callId: string, fromSeq: number, signal: AbortSignal,
): Promise<McpAppActivityOutput> {
    const result = record(await request(session,
        `/activity?callId=${encodeURIComponent(callId)}&fromSeq=${fromSeq}`, signal));
    if (result?.callId !== callId || typeof result.stdout !== "string" ||
        typeof result.stderr !== "string" ||
        (result.nextSeq !== undefined &&
            (typeof result.nextSeq !== "number" || !Number.isSafeInteger(result.nextSeq) ||
                result.nextSeq <= fromSeq)))
        throw new Error("Invalid MCP App Activity output");
    return result as unknown as McpAppActivityOutput;
}

export async function readMcpAppSnapshot(session: McpAppSession, signal: AbortSignal): Promise<McpAppSnapshot> {
    const result = await request(session, "/snapshot", signal);
    if (!isSnapshot(result) || result.ctxId !== session.ctxId) throw new Error("Invalid MCP App snapshot");
    return result;
}

export async function watchMcpApp(
    session: McpAppSession, cursor: number, signal: AbortSignal,
): Promise<{ changed: boolean; cursor: number; snapshot?: McpAppSnapshot }> {
    const result = await request(session, `/watch?cursor=${cursor}`, signal);
    const watch = record(result);
    if (typeof watch?.changed !== "boolean" || typeof watch.cursor !== "number" ||
        !Number.isSafeInteger(watch.cursor) || watch.cursor < 0) throw new Error("Invalid MCP App watch result");
    if (watch.changed && (!isSnapshot(watch.snapshot) || watch.snapshot.ctxId !== session.ctxId))
        throw new Error("Invalid MCP App watch snapshot");
    return {
        changed: watch.changed,
        cursor: watch.cursor,
        ...(watch.changed ? { snapshot: watch.snapshot as McpAppSnapshot } : {}),
    };
}

async function request(session: McpAppSession, path: string, signal: AbortSignal): Promise<unknown> {
    const url = `${session.liveBaseUrl}${path}${path.includes("?") ? "&" : "?"}ctxId=${encodeURIComponent(session.ctxId)}`;
    const response = await fetch(url, {
        cache: "no-store",
        credentials: "omit",
        headers: { Authorization: `Bearer ${session.token}` },
        signal,
    });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
        ? "MCP App authorization expired" : `MCP App HTTP ${response.status}`);
    return await response.json() as unknown;
}

function isSnapshot(value: unknown): value is McpAppSnapshot {
    const data = record(value);
    const presentation = record(data?.presentation);
    return typeof data?.ctxId === "string" && typeof data.instance === "string" &&
        typeof data.cursor === "number" && Number.isSafeInteger(data.cursor) && data.cursor >= 0 &&
        typeof data.agentBusy === "boolean" && Array.isArray(presentation?.work) &&
        Array.isArray(presentation.background);
}

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown> : undefined;
}

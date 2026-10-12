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
        input?: { kind: "none" } | { kind: "text"; placeholder?: string } |
            { kind: "choice"; choices: Array<{ id: string; label: string }> };
    }>;
}
export interface McpAppSnapshot {
    ctxId: string;
    instance: string;
    cursor: number;
    questionRevision?: number;
    agentBusy: boolean;
    activity?: Array<{ callId: string; name: string; state: string; at: string; exitCode?: number }>;
    presentation: { primary?: McpAppItem; work: McpAppItem[]; background: McpAppItem[] };
    reentry?: {
        pending?: boolean;
        schedule?: { readyAt: string; intent: "automatic"; sourceId?: string };
        directives?: Array<{ kind: "reentry"; id?: string; intent: "goal-resume" | "goal-retry" | "automatic" | "task-resume"; sourceId?: string }>;
    };
}

export async function readMcpAppSnapshot(session: McpAppSession, signal: AbortSignal): Promise<McpAppSnapshot> {
    const result = await request(session, "/snapshot", signal);
    if (!isSnapshot(result) || result.ctxId !== session.ctxId) throw new Error("Invalid MCP App snapshot");
    return result;
}

export async function watchMcpApp(
    session: McpAppSession, cursor: number, signal: AbortSignal, questionRevision = 0,
): Promise<{ changed: boolean; cursor: number; snapshot?: McpAppSnapshot }> {
    const result = await request(session, `/watch?cursor=${cursor}&qrev=${questionRevision}`, signal);
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

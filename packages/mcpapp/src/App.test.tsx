import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
    clients: [] as Array<{
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        ontoolresult?: (result: unknown) => void;
        onclose?: () => void;
    }>,
}));

vi.mock("@modelcontextprotocol/ext-apps/app-with-deps", () => ({
    App: class {
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        ontoolresult?: (result: unknown) => void;
        onclose?: () => void;
        constructor() { host.clients.push(this); }
        async connect() {}
        getHostContext() { return { displayMode: "inline" }; }
        setupSizeChangedNotifications() { return () => undefined; }
        async close() {}
    },
    applyDocumentTheme: vi.fn(),
    applyHostFonts: vi.fn(),
    applyHostStyleVariables: vi.fn(),
}));

import { AppView } from "./App.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;

afterEach(async () => {
    if (root) await act(async () => { root?.unmount(); });
    container?.remove();
    root = undefined;
    container = undefined;
    host.clients.length = 0;
    globalThis.fetch = originalFetch;
});

test("connects to the MCP Apps host without manufacturing workspace state", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });

    expect(container.textContent).toContain("Connected");
    expect(container.textContent).toContain("Waiting for workspace");
    expect(container.textContent).not.toContain("Approval required");

    await act(async () => {
        host.clients[0]?.ontoolinput?.({ arguments: { ctxId: "ctx-m1", token: "private-token" } });
    });
    expect(container.textContent).toContain("Context · ctx-m1");
    expect(container.textContent).not.toContain("private-token");

    await act(async () => { host.clients[0]?.onclose?.(); });
    expect(container.textContent).toContain("Disconnected");
});

test("reads live workspace state from private MCP metadata without displaying bearer tokens", async () => {
    const calls: Array<{ url: string; authorization?: string; credentials?: string; signal?: AbortSignal }> = [];
    const snapshot = {
        ctxId: "ctx-live", instance: "demo", cursor: 6, agentBusy: true,
        presentation: {
            primary: { id: "approval-a", title: "Approval required", detail: "Inspect change" },
            work: [{ id: "goal-a", title: "Build portable devshell", badge: "Goal · active", progress: { current: 1, total: 3 } }],
            background: [],
        },
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, authorization: new Headers(init?.headers).get("Authorization") ?? undefined,
            credentials: init?.credentials, signal: init?.signal ?? undefined });
        if (url.includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 }));
        if (url.includes("/watch")) return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => {
        host.clients[0]?.ontoolresult?.({
            structuredContent: { ctxId: "ctx-live" },
            _meta: { "portable-devshell/mcpapp": {
                ctxId: "ctx-live", token: "private-authorization-token", liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
            } },
        });
        await Promise.resolve();
    });
    await vi.waitFor(() => {
        expect(container!.textContent).toContain("Approval required");
        expect(container!.textContent).toContain("Build portable devshell");
    });
    expect(container!.textContent).not.toContain("private-authorization-token");
    expect(calls[0]?.url).toContain("/snapshot?ctxId=ctx-live");
    expect(calls[0]?.authorization).toBe("Bearer private-authorization-token");
    expect(calls[0]?.credentials).toBe("omit");
    expect(calls.some((call) => call.url.includes("/watch?cursor=6&ctxId=ctx-live"))).toBe(true);
    await act(async () => { host.clients[0]?.ontoolinput?.({ arguments: { ctxId: "ctx-new" } }); });
    expect(container!.textContent).not.toContain("Approval required");
    expect(container!.textContent).not.toContain("Build portable devshell");
    expect(container!.textContent).toContain("Context · ctx-new");
    expect(calls.at(-1)?.signal?.aborted).toBe(true);
    await act(async () => { root?.unmount(); root = undefined; });
    expect(calls.at(-1)?.signal?.aborted).toBe(true);
});

test("revoked MCP App Lease removes stale UI and private persisted credentials", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    let widgetState: Record<string, unknown> = {};
    Object.assign(window, { openai: {
        get widgetState() { return widgetState; },
        setWidgetState(next: unknown) { widgetState = next as Record<string, unknown>; },
    } });
    const snapshot = {
        ctxId: "ctx-revoked", instance: "demo", cursor: 7, agentBusy: true,
        presentation: { primary: { id: "approval", title: "Sensitive approval" }, work: [], background: [] },
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(String(input).includes("/snapshot")
            ? new Response(JSON.stringify(snapshot), { status: 200 })
            : new Response("{}", { status: 401 }))) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView />); });
        await act(async () => { host.clients[0]?.ontoolresult?.({
            _meta: { "portable-devshell/mcpapp": {
                ctxId: "ctx-revoked", token: "expired-test-bearer-token", liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
            } },
        }); });
        await vi.waitFor(() => {
            expect(container!.textContent).toContain("MCP App authorization expired");
            expect(container!.textContent).not.toContain("Sensitive approval");
        });
        expect(JSON.stringify(widgetState)).not.toContain("expired-test-bearer-token");
    } finally {
        Object.assign(window, { openai: previousOpenai });
    }
});

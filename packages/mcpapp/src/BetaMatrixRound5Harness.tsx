import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, vi } from "vitest";
import type { McpAppSnapshot } from "./Connection.js";

type Call = { name: string; arguments: Record<string, unknown> };
const hostState = vi.hoisted(() => ({
    clients: [] as Array<{
        ontoolresult?: (value: unknown) => void;
        ontoolinput?: (value: { arguments: Record<string, unknown> }) => void;
    }>,
    calls: [] as Call[], sent: [] as unknown[], contexts: [] as unknown[], modes: [] as string[],
    invoke: undefined as undefined | ((call: Call) => Promise<unknown>),
    contextError: undefined as Error | undefined,
    sendError: undefined as Error | undefined,
    teardownError: undefined as Error | undefined,
    fullscreen: false, acceptFullscreen: true, closed: 0, sizeStopped: 0, teardown: 0,
}));
export const host = hostState;
vi.mock("@modelcontextprotocol/ext-apps/app-with-deps", () => ({
    App: class {
        constructor() { hostState.clients.push(this); }
        ontoolresult?: (value: unknown) => void;
        async connect() {}
        async close() { host.closed++; }
        getHostContext() {
            return { displayMode: "inline", availableDisplayModes: host.fullscreen ? ["inline", "fullscreen"] : ["inline"] };
        }
        setupSizeChangedNotifications() { return () => { host.sizeStopped++; }; }
        async requestDisplayMode({ mode }: { mode: string }) {
            host.modes.push(mode);
            return { mode: host.acceptFullscreen ? mode : "inline" };
        }
        async requestTeardown() {
            host.teardown++;
            if (host.teardownError) throw host.teardownError;
        }
        async callServerTool(call: Call) {
            host.calls.push(call);
            return host.invoke ? await host.invoke(call) : { isError: false, structuredContent: { status: "applied" } };
        }
        async updateModelContext(value: unknown) {
            host.contexts.push(value);
            if (host.contextError) throw host.contextError;
            return {};
        }
        async sendMessage(value: unknown) {
            host.sent.push(value);
            if (host.sendError) throw host.sendError;
            return {};
        }
    },
    applyDocumentTheme: vi.fn(), applyHostFonts: vi.fn(), applyHostStyleVariables: vi.fn(),
}));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const originalFetch = globalThis.fetch;
const originalOpenai = (window as Window & { openai?: unknown }).openai;
export let container: HTMLDivElement;
let root: Root | undefined;
export function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}
export function capability(ctxId = "ctx-a", instance = "alpha") {
    return { ctxId, token: "round5-private-test-token", liveBaseUrl: `https://devshell.example/api/live/${instance}/workspace` };
}
export function snapshot(ctxId = "ctx-a", instance = "alpha", cursor = 11): McpAppSnapshot {
    return { ctxId, instance, cursor, agentBusy: true, presentation: {
        work: [{ id: "goal-a", title: `Goal ${ctxId}`, actions: [
            { id: "goal-pause", label: "Pause Goal", expectedRevision: cursor, confirmation: { message: "Pause?" } },
        ] }, { id: "todo-a", title: `Todo ${ctxId}`, actions: [
            { id: "task-resume", label: "Resume Todo", expectedRevision: cursor + 2 },
        ] }],
        primary: { id: "approval-a", title: "Approval required", actions: [
            { id: "approve", label: "Approve" }, { id: "deny", label: "Deny" },
        ] },
        background: [{ id: "wait-a", title: "Long build", badge: "Wait · active", detail: "task-tmux-a" }],
    } };
}
export function recovery(state = snapshot(), intent: "goal-resume" | "task-resume" = "goal-resume") {
    return { ...state, reentry: { directives: [{ kind: "reentry" as const,
        id: "directive-a", intent, sourceId: intent === "task-resume" ? "todo-a" : "goal-a" }] } };
}
export function result(value: unknown) { return { isError: false, structuredContent: value }; }
export function claim() { return result({ claimed: true,
    delivery: { message: "Resume authorized work", modelContext: { structuredContent: { revision: 11 } } } }); }
export function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }
export function hold(signal?: AbortSignal | null) {
    return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
}
export function serve(read: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
    globalThis.fetch = vi.fn((input, init) => {
        const url = new URL(String(input));
        return Promise.resolve(read(url, init));
    }) as typeof fetch;
}
export function serveSnapshot(state: McpAppSnapshot) {
    serve((url, init) => url.pathname.endsWith("/snapshot") ? response(state) : hold(init?.signal));
}
export async function render(view: ReactNode) {
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root!.render(view); });
}
export async function unmount() {
    await act(async () => { root!.unmount(); }); root = undefined; container.remove();
}
export async function authorize(ctxId = "ctx-a", instance = "alpha") {
    await act(async () => { host.clients.at(-1)!.ontoolresult!({ _meta: {
        "portable-devshell/mcpapp": capability(ctxId, instance),
    } }); });
}
export function button(label: string) {
    const found = Array.from(container.querySelectorAll("button")).find((item) => item.textContent === label);
    expect(found, `Rendered button: ${label}`).toBeDefined(); return found!;
}
export async function click(label: string) { await act(async () => { button(label).click(); }); }
export function phases() { return host.calls.filter((call) => call.name === "mcpapp_reentry").map((call) => call.arguments.action); }
export function actions() { return host.calls.filter((call) => call.name === "mcpapp_action"); }
afterEach(async () => {
    await act(async () => { root?.unmount(); }); root = undefined; container?.remove();
    host.clients.length = 0; host.calls.length = 0; host.sent.length = 0; host.contexts.length = 0; host.modes.length = 0;
    host.invoke = undefined; host.contextError = undefined; host.sendError = undefined; host.teardownError = undefined;
    host.fullscreen = false; host.acceptFullscreen = true; host.closed = 0; host.sizeStopped = 0; host.teardown = 0;
    globalThis.fetch = originalFetch; Object.assign(window, { openai: originalOpenai });
});

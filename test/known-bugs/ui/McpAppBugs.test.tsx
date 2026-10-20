import { act } from "../../../packages/mcpapp/node_modules/react/index.js";
import { createRoot, type Root } from "../../../packages/mcpapp/node_modules/react-dom/client.js";
import { afterEach, expect, test, vi } from "vitest";
import type { McpAppSnapshot } from "../../../packages/mcpapp/src/Connection.js";

const host = vi.hoisted(() => ({
    clients: [] as Array<{ ontoolresult?: (value: unknown) => void }>,
    calls: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
    invoke: undefined as undefined | ((name: string, args: Record<string, unknown>) => Promise<unknown>),
    sent: [] as unknown[], contexts: [] as unknown[],
}));
vi.mock("@modelcontextprotocol/ext-apps/app-with-deps", () => ({
    App: class {
        constructor() { host.clients.push(this); }
        ontoolresult?: (value: unknown) => void;
        async connect() {}
        async close() {}
        getHostContext() { return { displayMode: "inline", availableDisplayModes: ["inline"] }; }
        setupSizeChangedNotifications() { return () => undefined; }
        async callServerTool(call: { name: string; arguments: Record<string, unknown> }) {
            host.calls.push(call);
            return host.invoke ? await host.invoke(call.name, call.arguments) : { isError: true, content: [] };
        }
        async updateModelContext(value: unknown) { host.contexts.push(value); return {}; }
        async sendMessage(value: unknown) { host.sent.push(value); return {}; }
    },
    applyDocumentTheme: vi.fn(), applyHostFonts: vi.fn(), applyHostStyleVariables: vi.fn(),
}));
import { AppView } from "../../../packages/mcpapp/src/App.js";
import { WorkspaceDashboard } from "../../../packages/mcpapp/src/Workspace.js";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root | undefined;
let container: HTMLDivElement | undefined;
const originalFetch = globalThis.fetch;
const originalOpenai = (window as Window & { openai?: unknown }).openai;
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((yes) => { resolve = yes; });
    return { promise, resolve };
}
function capability(ctxId: string) {
    return { ctxId, token: "private-round3-bearer-token", liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
}
function snapshot(ctxId = "context-a", revision = 7): McpAppSnapshot {
    return { ctxId, instance: "demo", cursor: revision, agentBusy: true,
        presentation: { work: [{ id: "same-goal", title: `Goal in ${ctxId}`, actions: [
            { id: "goal-stop", label: "Stop", expectedRevision: revision, confirmation: { message: "Stop this Goal?" } },
        ] }], background: [], primary: { id: "approval-a", title: "Approval required", actions: [
            { id: "approve", label: "Approve" }, { id: "deny", label: "Deny", confirmation: { message: "Deny?" } },
        ] } } };
}
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200 }); }
function hold(signal?: AbortSignal | null) {
    return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
}
async function mount(view: "workspace" | "interaction" = "workspace") {
    Object.assign(window, { openai: undefined });
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => { root!.render(<AppView view={view} />); });
}
async function authorize(ctxId = "context-a") {
    await act(async () => { host.clients.at(-1)!.ontoolresult!({ _meta: { "portable-devshell/mcpapp": capability(ctxId) } }); });
}
function button(name: string) {
    const element = Array.from(container!.querySelectorAll("button")).find((entry) => entry.textContent === name);
    expect(element, `Expected rendered action ${name}`).toBeDefined();
    return element!;
}
function actions() { return host.calls.filter((call) => call.name === "mcpapp_action"); }
afterEach(async () => {
    await act(async () => { root?.unmount(); });
    container?.remove(); root = undefined; container = undefined;
    host.clients.length = 0; host.calls.length = 0; host.sent.length = 0; host.contexts.length = 0;
    host.invoke = undefined; globalThis.fetch = originalFetch;
    Object.assign(window, { openai: originalOpenai });
});


test("confirmation for old Context must not authorize a replacement Context sharing item and action ids", async () => {
    host.invoke = async () => ({ isError: false, structuredContent: { status: "applied" } });
    globalThis.fetch = vi.fn((input, init) => String(input).includes("/snapshot")
        ? Promise.resolve(response(snapshot(new URL(String(input)).searchParams.get("ctxId")!))) : hold(init?.signal)) as typeof fetch;
    await mount(); await authorize();
    await act(async () => { button("Stop").click(); });
    await authorize("context-b");
    expect(container!.textContent).toContain("Goal in context-b");
    // Query the visible Stop control without assuming its old/new confirmation text.
    const stop = container!.querySelector<HTMLButtonElement>(".workspace-actions button")!;
    await act(async () => { stop.click(); });
    expect(actions()).toHaveLength(0);
    expect(button("Confirm Stop").disabled).toBe(false);
});

test("confirmation of revision 7 cannot silently become consent to revision 8", async () => {
    const watch = deferred<Response>(); let current = snapshot();
    host.invoke = async () => ({ isError: false, structuredContent: { status: "applied" } });
    let watches = 0;
    globalThis.fetch = vi.fn((input, init) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(response(current));
        watches++;
        return watches === 1 ? watch.promise : hold(init?.signal);
    }) as typeof fetch;
    await mount(); await authorize();
    await act(async () => { button("Stop").click(); });
    current = snapshot("context-a", 8);
    await act(async () => watch.resolve(response({ changed: true, cursor: 8, snapshot: current })));
    const stop = container!.querySelector<HTMLButtonElement>(".workspace-actions button")!;
    await act(async () => { stop.click(); });
    expect(actions()).toHaveLength(0);
    expect(button("Confirm Stop").disabled).toBe(false);
});

test("late recovery refresh cannot restore the old Context after replacement", async () => {
    const oldRefresh = deferred<Response>(); let readsA = 0;
    const old = { ...snapshot(), reentry: { directives: [{
        kind: "reentry", id: "receipt-old", intent: "goal-resume", sourceId: "same-goal",
    }] } };
    host.invoke = async () => ({ isError: false, structuredContent: { claimed: false } });
    globalThis.fetch = vi.fn((input, init) => {
        const url = String(input);
        if (!url.includes("/snapshot")) return hold(init?.signal);
        if (url.includes("context-b")) return Promise.resolve(response(snapshot("context-b")));
        readsA++;
        return readsA === 1 ? Promise.resolve(response(old)) : oldRefresh.promise;
    }) as typeof fetch;
    await mount(); await authorize();
    await vi.waitFor(() => expect(readsA).toBe(2));
    await authorize("context-b");
    expect(container!.textContent).toContain("Goal in context-b");
    await act(async () => oldRefresh.resolve(response(snapshot("context-a"))));
    expect(container!.textContent).toContain("Goal in context-b");
    expect(container!.textContent).not.toContain("Goal in context-a");
});

test("an action refresh cannot roll back a newer watch revision in the same Context", async () => {
    const watch = deferred<Response>(); const actionRefresh = deferred<Response>();
    let reads = 0; let watches = 0;
    host.invoke = async () => ({ isError: false, structuredContent: { status: "applied" } });
    globalThis.fetch = vi.fn((input, init) => {
        if (String(input).includes("/snapshot")) {
            reads++;
            return reads === 1 ? Promise.resolve(response(snapshot())) : actionRefresh.promise;
        }
        watches++;
        return watches === 1 ? watch.promise : hold(init?.signal);
    }) as typeof fetch;
    await mount(); await authorize();
    await act(async () => { button("Stop").click(); });
    await act(async () => { button("Confirm Stop").click(); });
    expect(reads).toBe(2);
    const newer = snapshot("context-a", 9);
    newer.presentation.work[0]!.title = "Newer revision 9";
    await act(async () => watch.resolve(response({ changed: true, cursor: 9, snapshot: newer })));
    expect(container!.textContent).toContain("Newer revision 9");
    await act(async () => actionRefresh.resolve(response(snapshot("context-a", 8))));
    expect(container!.textContent).toContain("Newer revision 9");
});

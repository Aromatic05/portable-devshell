import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";
import type { McpAppSnapshot } from "./Connection.js";

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
import { AppView } from "./App.js";
import { WorkspaceDashboard } from "./Workspace.js";
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

// Tests exercise rendered actions rather than snapshot projection alone.
test("round3: busy agent permits Inline approval while its pending request blocks duplicate dispatch", async () => {
    const pending = deferred<unknown>();
    host.invoke = async (name) => name === "mcpapp_open"
        ? { isError: false, _meta: { "portable-devshell/mcpapp": capability("context-a") } } : await pending.promise;
    globalThis.fetch = vi.fn((input, init) => String(input).includes("/snapshot")
        ? Promise.resolve(response(snapshot())) : hold(init?.signal)) as typeof fetch;
    await mount("interaction");
    await vi.waitFor(() => expect(container!.textContent).toContain("Approval required"));
    expect(button("Approve").disabled).toBe(false);
    await act(async () => { button("Approve").click(); });
    expect(actions()).toHaveLength(1);
    expect(button("Applying…").disabled).toBe(true);
    expect(button("Deny").disabled).toBe(true);
    await act(async () => { button("Applying…").click(); button("Deny").click(); });
    expect(actions()).toHaveLength(1);
    expect(actions()[0]!.arguments).toMatchObject({ ctxId: "context-a", itemId: "approval-a", actionId: "approve" });
    await act(async () => pending.resolve({ isError: false, structuredContent: { status: "applied" } }));
    expect(button("Approve").disabled).toBe(false);
});

test("round3: stale action receipt refreshes revision and requires renewed explicit confirmation", async () => {
    let current = snapshot();
    host.invoke = async () => { current = snapshot("context-a", 8); return { isError: false, structuredContent: { status: "stale" } }; };
    globalThis.fetch = vi.fn((input, init) => String(input).includes("/snapshot")
        ? Promise.resolve(response(current)) : hold(init?.signal)) as typeof fetch;
    await mount(); await authorize();
    await act(async () => { button("Stop").click(); });
    expect(actions()).toHaveLength(0);
    await act(async () => { button("Confirm Stop").click(); });
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain("review the latest status");
    expect(actions()[0]!.arguments.expectedRevision).toBe(7);
    expect(actions()).toHaveLength(1);
    await act(async () => { button("Stop").click(); });
    expect(actions()).toHaveLength(1);
    await act(async () => { button("Confirm Stop").click(); });
    expect(actions()[1]!.arguments.expectedRevision).toBe(8);
    expect(actions()[1]!.arguments.requestId).not.toBe(actions()[0]!.arguments.requestId);
});

test("round3: late old Context snapshot cannot replace newly authorized Context", async () => {
    const old = deferred<Response>(); const signals: AbortSignal[] = [];
    globalThis.fetch = vi.fn((input, init) => {
        const url = String(input);
        if (url.includes("/snapshot") && url.includes("context-a")) { signals.push(init!.signal!); return old.promise; }
        return url.includes("/snapshot") ? Promise.resolve(response(snapshot("context-b"))) : hold(init?.signal);
    }) as typeof fetch;
    await mount(); await authorize(); await authorize("context-b");
    expect(container!.textContent).toContain("Goal in context-b");
    expect(signals[0]!.aborted).toBe(true);
    await act(async () => old.resolve(response(snapshot("context-a"))));
    expect(container!.textContent).toContain("Goal in context-b");
    expect(container!.textContent).not.toContain("Goal in context-a");
    expect(actions()).toHaveLength(0);
});

test("round3: old action completion cannot overwrite replacement Context or replay the action", async () => {
    const pending = deferred<unknown>(); host.invoke = async () => await pending.promise;
    const reads: string[] = [];
    globalThis.fetch = vi.fn((input, init) => {
        const url = String(input);
        if (url.includes("/snapshot")) {
            const ctxId = new URL(url).searchParams.get("ctxId")!;
            reads.push(ctxId); return Promise.resolve(response(snapshot(ctxId)));
        }
        return hold(init?.signal);
    }) as typeof fetch;
    await mount(); await authorize();
    await act(async () => { button("Stop").click(); });
    await act(async () => { button("Confirm Stop").click(); });
    await authorize("context-b");
    await act(async () => pending.resolve({ isError: false, structuredContent: { status: "applied" } }));
    expect(container!.textContent).toContain("Goal in context-b");
    expect(container!.textContent).not.toContain("Goal in context-a");
    expect(reads).toEqual(["context-a", "context-b"]);
    expect(actions()).toHaveLength(1);
    expect(button("Stop").disabled).toBe(false);
});

test("round3: retained Audit output survives dashboard remount through a fresh authenticated read", async () => {
    const requests: string[] = [];
    globalThis.fetch = vi.fn((input, init) => {
        requests.push(String(input));
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer private-round3-bearer-token");
        return Promise.resolve(response({ callId: "retained-call", stdout: "persisted audit output", stderr: "" }));
    }) as typeof fetch;
    const state: McpAppSnapshot = { ...snapshot(), activity: [{ callId: "retained-call", name: "bash_run",
        state: "completed", at: "2026-10-20T00:00:00Z", target: "echo retained" }] };
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    const view = <WorkspaceDashboard snapshot={state} session={capability("context-a")} renderItem={() => null} />;
    await act(async () => { root!.render(view); });
    await act(async () => { button("Activity").click(); });
    expect(requests).toHaveLength(0);
    await act(async () => { container!.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container!.textContent).toContain("persisted audit output");
    await act(async () => { root!.unmount(); }); root = createRoot(container);
    await act(async () => { root!.render(view); });
    await act(async () => { button("Activity").click(); });
    expect(container!.textContent).not.toContain("persisted audit output");
    await act(async () => { container!.querySelector<HTMLButtonElement>(".toolcall-compact")!.click(); });
    expect(container!.textContent).toContain("persisted audit output");
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("callId=retained-call&fromSeq=1&ctxId=context-a");
    expect(requests[1]).toBe(requests[0]);
});

test("round3: delivered recovery receipt is reclaimed after Host remount without duplicate delivery", async () => {
    const state = { ...snapshot(), reentry: { directives: [{
        kind: "reentry", id: "receipt-persisted", intent: "goal-resume", sourceId: "same-goal",
    }] } };
    let delivered = false; const phases: string[] = [];
    host.invoke = async (_name, args) => {
        phases.push(String(args.action));
        if (args.action === "claim") return { isError: false, structuredContent: { claimed: !delivered,
            delivery: { message: "Resume authorized Goal", modelContext: { structuredContent: { safe: true } } } } };
        if (args.action === "report") delivered = true;
        return { isError: false, structuredContent: { valid: true, attempted: true } };
    };
    globalThis.fetch = vi.fn((input, init) => String(input).includes("/snapshot")
        ? Promise.resolve(response(state)) : hold(init?.signal)) as typeof fetch;
    await mount(); await authorize();
    await vi.waitFor(() => expect(phases).toEqual(["claim", "validate", "attempt", "report"]));
    expect(host.sent).toHaveLength(1);
    await act(async () => { root!.unmount(); }); root = createRoot(container!);
    await act(async () => { root!.render(<AppView />); }); await authorize();
    await vi.waitFor(() => expect(phases).toEqual(["claim", "validate", "attempt", "report", "claim"]));
    expect(host.sent).toHaveLength(1);
    expect(host.contexts).toHaveLength(1);
});

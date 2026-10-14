import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

const host = vi.hoisted(() => ({
    actions: [] as Array<{ name: string; arguments: Record<string, unknown> }>,
    recovery: undefined as undefined | ((request: Record<string, unknown>) => Record<string, unknown>),
    actionResult: undefined as undefined | Record<string, unknown>,
    sent: [] as unknown[],
    modelContexts: [] as unknown[],
    failModelContext: false,
    failSend: false,
    bootstrapCapability: undefined as undefined | Record<string, unknown>,
    bootstrapCalls: 0,
    teardownRequests: 0,
    resizeSubscriptions: 0,
    availableDisplayModes: ["inline"] as string[],
    displayMode: "inline",
    modeAccepted: true,
    modeRequests: [] as string[],
    clients: [] as Array<{
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        ontoolresult?: (result: unknown) => void;
        onclose?: () => void;
        onhostcontextchanged?: (context: { displayMode?: string }) => void;
    }>,
}));

vi.mock("@modelcontextprotocol/ext-apps/app-with-deps", () => ({
    App: class {
        ontoolinput?: (input: { arguments?: Record<string, unknown> }) => void;
        ontoolresult?: (result: unknown) => void;
        onclose?: () => void;
        readonly options: { autoResize?: boolean };
        constructor(_info: unknown, _capabilities: unknown, options: { autoResize?: boolean } = {}) {
            this.options = options;
            host.clients.push(this);
        }
        async connect() { if (this.options.autoResize) this.setupSizeChangedNotifications(); }
        getHostContext() { return { displayMode: host.displayMode, availableDisplayModes: host.availableDisplayModes }; }
        async requestDisplayMode(params: { mode: "inline" | "fullscreen" }) {
            host.modeRequests.push(params.mode);
            if (host.modeAccepted) host.displayMode = params.mode;
            return { mode: host.displayMode };
        }
        async requestTeardown() { host.teardownRequests++; }
        setupSizeChangedNotifications() { host.resizeSubscriptions++; return () => undefined; }
        async callServerTool(params: { name: string; arguments: Record<string, unknown> }) {
            if (params.name === "mcpapp_open") {
                host.bootstrapCalls++;
                return { isError: host.bootstrapCapability === undefined, content: [],
                    structuredContent: { status: "ready" },
                    _meta: { "portable-devshell/mcpapp": host.bootstrapCapability } };
            }
            host.actions.push(params);
            if (params.name === "mcpapp_reentry" && host.recovery)
                return { isError: false, content: [], structuredContent: host.recovery(params.arguments) };
            return { isError: false, content: [], structuredContent: host.actionResult ?? { status: "applied" } };
        }
        async updateModelContext(value: unknown) {
            host.modelContexts.push(value);
            if (host.failModelContext) throw new Error("Host rejected model context");
            return {};
        }
        async sendMessage(value: unknown) {
            host.sent.push(value);
            if (host.failSend) throw new Error("Host delivery outcome unknown");
            return { isError: false };
        }
        async close() {}
    },
    applyDocumentTheme: vi.fn(),
    applyHostFonts: vi.fn(),
    applyHostStyleVariables: vi.fn(),
}));

import { AppView } from "./App.js";
import { ToolCallCard } from "./ToolCall.js";
import { writeToolCallDisplay } from "./Preferences.js";

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
    host.actions.length = 0;
    host.recovery = undefined;
    host.actionResult = undefined;
    host.sent.length = 0;
    host.modelContexts.length = 0;
    host.failModelContext = false;
    host.failSend = false;
    host.bootstrapCapability = undefined;
    host.bootstrapCalls = 0;
    host.teardownRequests = 0;
    host.resizeSubscriptions = 0;
    host.availableDisplayModes = ["inline"];
    host.displayMode = "inline";
    host.modeAccepted = true;
    host.modeRequests.length = 0;
    globalThis.fetch = originalFetch;
    writeToolCallDisplay(true);
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
        expect(container!.textContent).toContain("Build portable devshell");
        expect(container!.textContent).toContain("An approval is pending in the conversation.");
    });
    expect(container!.textContent).toContain("An approval is pending in the conversation.");
    expect(container!.textContent).not.toContain("private-authorization-token");
    expect(calls[0]?.url).toContain("/snapshot?ctxId=ctx-live");
    expect(calls[0]?.authorization).toBe("Bearer private-authorization-token");
    expect(calls[0]?.credentials).toBe("omit");
    expect(calls.some((call) => call.url.includes("/watch?cursor=6&qrev=0&ctxId=ctx-live"))).toBe(true);
    await act(async () => { host.clients[0]?.ontoolinput?.({ arguments: { ctxId: "ctx-new" } }); });
    expect(container!.textContent).not.toContain("An approval is pending in the conversation.");
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

test("MCPApp user controls use callServerTool with Context, revision and confirmation", async () => {
    const snapshot = {
        ctxId: "ctx-human", instance: "demo", cursor: 9, agentBusy: true,
        presentation: {
            primary: { id: "approval-one", title: "Approval required", actions: [
                { id: "approve", label: "Approve" }, { id: "deny", label: "Deny", confirmation: { message: "Deny?" } },
            ] },
            work: [{ id: "goal-one", title: "Deploy securely", actions: [
                { id: "goal-pause", label: "Pause", expectedRevision: 7 },
            ] }], background: [],
        },
    };
    let reads = 0;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) {
            reads++;
            return Promise.resolve(new Response(JSON.stringify(snapshot), { status: 200 }));
        }
        if (String(input).includes("/watch")) return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error("Unexpected request");
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => {
        host.clients[0]?.ontoolresult?.({ _meta: { "portable-devshell/mcpapp": {
            ctxId: "ctx-human", token: "valid-test-bearer-token", liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
        } } });
    });
    await vi.waitFor(() => expect(container!.textContent).toContain("Deploy securely"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
        .find((entry) => entry.textContent === name)!;
    await act(async () => { button("Pause").click(); });
    await vi.waitFor(() => expect(host.actions).toHaveLength(1));
    expect(host.actions[0]).toEqual({ name: "mcpapp_action", arguments: {
        ctxId: "ctx-human", itemId: "goal-one", actionId: "goal-pause", expectedRevision: 7,
        requestId: expect.any(String),
    } });
    expect(reads).toBeGreaterThan(1);
    // The fullscreen dashboard reports pending approval; the action is inline.
    expect(button("Deny")).toBeUndefined();
    expect(container!.textContent).toContain("An approval is pending in the conversation.");
});

test("server Goal recovery intent delivers model context and one Host message after claim", async () => {
    const state = {
        ctxId: "ctx-recovery", instance: "demo", cursor: 16, agentBusy: false,
        presentation: { work: [{ id: "goal-recovered", title: "Continue a Goal" }], background: [] },
        reentry: { pending: true, directives: [{
            kind: "reentry", id: "receipt-goal-resume", intent: "goal-resume", sourceId: "goal-recovered",
        }] },
    };
    host.recovery = (request) => {
        if (request.action === "claim") return { claimed: true, delivery: {
            message: "Resume Context-owned Goal", modelContext: {
                structuredContent: { portableDevshellMcpApp: { ctxId: "ctx-recovery" } },
            },
        } };
        if (request.action === "validate") return { valid: true };
        if (request.action === "attempt") return { attempted: true };
        return {};
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
        if (String(input).includes("/watch")) return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error("Unexpected request");
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({
        _meta: { "portable-devshell/mcpapp": {
            ctxId: "ctx-recovery", token: "authorized-private-token", liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
        } },
    }); });
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.modelContexts).toHaveLength(1);
    expect(JSON.stringify(host.modelContexts[0])).toContain("ctx-recovery");
    expect(host.sent[0]).toEqual({
        role: "user", content: [{ type: "text", text: "Resume Context-owned Goal" }],
    });
    await vi.waitFor(() => expect(host.actions.filter((value) => value.name === "mcpapp_reentry").map((value) => value.arguments.action))
        .toEqual(["claim", "validate", "attempt", "report"]));
    expect(host.actions[0]?.arguments).toEqual(expect.objectContaining({
        ctxId: "ctx-recovery", directiveId: "receipt-goal-resume", sourceId: "goal-recovered", intent: "goal-resume",
    }));
    expect(host.actions[3]?.arguments.outcome).toBe("accepted");
    await act(async () => { host.clients[0]?.ontoolinput?.({ arguments: { ctxId: "ctx-other" } }); });
    expect(host.sent).toHaveLength(1);
});

test("server Task resume directive delivers exactly one Host message", async () => {
    const state = {
        ctxId: "ctx-task", instance: "demo", cursor: 18, agentBusy: false,
        presentation: { work: [{ id: "todo-one", title: "Continue Todo" }], background: [] },
        reentry: { pending: true, directives: [{
            kind: "reentry", id: "task-receipt", intent: "task-resume", sourceId: "todo-one",
        }] },
    };
    host.recovery = (request) => {
        if (request.action === "claim") return { claimed: true, delivery: {
            message: "Resume authorized Todo", modelContext: { structuredContent: { todo: "todo-one" } },
        } };
        if (request.action === "validate") return { valid: true };
        if (request.action === "attempt") return { attempted: true };
        return {};
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot"))
            return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
        if (String(input).includes("/watch")) return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error("Unexpected request");
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: { "portable-devshell/mcpapp": {
        ctxId: "ctx-task", token: "private-task-lease", liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
    } } }); });
    await vi.waitFor(() => expect(host.actions.map((value) => value.arguments.action))
        .toEqual(["claim", "validate", "attempt", "report"]));
    expect(host.actions.every((value) => value.arguments.intent === "task-resume" &&
        value.arguments.sourceId === "todo-one" && value.arguments.directiveId === "task-receipt")).toBe(true);
    expect(host.sent).toEqual([{ role: "user", content: [{ type: "text", text: "Resume authorized Todo" }] }]);
    expect(host.modelContexts).toHaveLength(1);
    expect(container.textContent).not.toContain("private-task-lease");
});

function recoverySnapshotForFailure() {
    return {
        ctxId: "ctx-failure", instance: "demo", cursor: 12, agentBusy: false,
        presentation: { work: [], background: [] },
        reentry: { pending: true, directives: [{
            kind: "reentry", id: "receipt-failure", intent: "goal-resume", sourceId: "goal-a",
        }] },
    };
}

async function mountRecoveryFailure(kind: "model-context" | "send-message") {
    host.failModelContext = kind === "model-context";
    host.failSend = kind === "send-message";
    host.recovery = (request) => {
        if (request.action === "claim") return { claimed: true, delivery: {
            message: "Resume Goal after failed Host handoff",
            modelContext: { structuredContent: { portableDevshellMcpApp: { ctxId: "ctx-failure" } } },
        } };
        if (request.action === "validate") return { valid: true };
        if (request.action === "attempt") return { attempted: true };
        return {};
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot"))
            return Promise.resolve(new Response(JSON.stringify(recoverySnapshotForFailure()), { status: 200 }));
        if (String(input).includes("/watch")) return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
                reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
        throw new Error("Unexpected MCP App request");
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => {
        host.clients[0]?.ontoolresult?.({ _meta: { "portable-devshell/mcpapp": {
            ctxId: "ctx-failure", token: "private-reentry-capability",
            liveBaseUrl: "https://devshell.example/api/live/demo/workspace",
        } } });
    });
}

test("React MCP App releases a claimed Reentry when Host model-context injection fails", async () => {
    await mountRecoveryFailure("model-context");
    await vi.waitFor(() => expect(host.actions.map((call) => call.arguments.action))
        .toEqual(["claim", "validate", "release"]));
    expect(host.modelContexts).toHaveLength(1);
    expect(host.sent).toHaveLength(0);
    expect(host.actions.some((call) => call.arguments.action === "attempt")).toBe(false);
    expect(container!.textContent).toContain("Host rejected model context");
});

test("React MCP App reports uncertain Host delivery without replaying a Reentry", async () => {
    await mountRecoveryFailure("send-message");
    await vi.waitFor(() => expect(host.actions.map((call) => call.arguments.action))
        .toEqual(["claim", "validate", "attempt", "report"]));
    expect(host.actions.at(-1)?.arguments.outcome).toBe("uncertain");
    expect(host.sent).toHaveLength(1);
    expect(host.modelContexts).toHaveLength(1);
    await vi.waitFor(() => expect(container!.textContent).toContain("Host delivery outcome unknown"));
    await act(async () => { await Promise.resolve(); });
    expect(host.actions.filter((call) => call.arguments.action === "claim")).toHaveLength(1);
    expect(host.sent).toHaveLength(1);
});


test("reads complete ChatGPT toolResponseMetadata before the SDK emits a tool-result event", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    const token = "private-token-via-global-metadata";
    const capability = { ctxId: "ctx-globals", token,
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    Object.assign(window, { openai: { toolResponseMetadata: {
        mcp_tool_result: { _meta: { "portable-devshell/mcpapp": capability } },
    } } });
    const calls: string[] = [];
    globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        calls.push(String(url));
        if (String(url).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 12, questionRevision: 3,
            agentBusy: false, presentation: { primary: { id: "q1", title: "Question for you",
                detail: "Which release?" }, work: [], background: [] },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="interaction" />); });
        await vi.waitFor(() => expect(container!.textContent).toContain("Which release?"));
        expect(calls[0]).toContain("snapshot?ctxId=ctx-globals");
        expect(calls.some((url) => url.includes("watch?cursor=12&qrev=3&ctxId=ctx-globals"))).toBe(true);
        expect(container!.textContent).not.toContain(token);
    } finally { Object.assign(window, { openai: previousOpenai }); }
});

test("question card sends selected choice and free text through authenticated MCP App action", async () => {
    const capability = { ctxId: "ctx-question", token: "private-question-test-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    let choice = true;
    globalThis.fetch = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
        if (String(url).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 14, questionRevision: 7,
            agentBusy: true, presentation: {
                primary: { id: "question-1", title: "Question for you", detail: "Proceed?",
                    actions: [{ id: choice ? "question-answer-choice" : "question-answer-text",
                        label: "Answer", input: choice ? { kind: "choice", choices: [{ id: "Yes", label: "Yes" }] }
                            : { kind: "text", placeholder: "Your answer" } }] },
                work: [], background: [],
            },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="interaction" />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: {
        "portable-devshell/mcpapp": capability,
    } }); });
    await vi.waitFor(() => expect(container!.textContent).toContain("Proceed?"));
    const yes = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Yes")!;
    await act(async () => { yes.click(); });
    await vi.waitFor(() => expect(host.actions).toHaveLength(1));
    expect(host.actions[0]).toEqual({ name: "mcpapp_action", arguments: expect.objectContaining({
        ctxId: capability.ctxId, itemId: "question-1", actionId: "question-answer-choice", input: "Yes",
    }) });
    choice = false;
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: {
        "portable-devshell/mcpapp": { ...capability, token: "private-question-test-token-new" },
    } }); });
    await vi.waitFor(() => expect(container!.querySelector('input[aria-label="Answer"]')).not.toBeNull());
    const input = container!.querySelector<HTMLInputElement>('input[aria-label="Answer"]')!;
    await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, "Keep compatible");
        input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = input.closest("form")!;
    await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    await vi.waitFor(() => expect(host.actions).toHaveLength(2));
    expect(host.actions[1]?.arguments).toEqual(expect.objectContaining({
        ctxId: capability.ctxId, itemId: "question-1", actionId: "question-answer-text", input: "Keep compatible",
    }));
});

test("Workspace requests fullscreen only once per Context and respects Host dismissal", async () => {
    host.availableDisplayModes = ["fullscreen"];
    const capability = { ctxId: "ctx-fullscreen", token: "valid-fullscreen-test-private-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 9, agentBusy: true,
            presentation: {
                primary: { id: "approval-x", title: "Approval required" },
                work: [{ id: "goal-x", title: "Build release" }], background: [],
            },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="workspace" />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({
        _meta: { "portable-devshell/mcpapp": capability },
    }); });
    await vi.waitFor(() => expect(host.modeRequests).toEqual(["fullscreen"]));
    expect(container!.textContent).toContain("Build release");
    expect(container!.textContent).toContain("An approval is pending in the conversation.");
    expect(host.displayMode).toBe("fullscreen");
    host.displayMode = "inline";
    await act(async () => { host.clients[0]?.onhostcontextchanged?.({ displayMode: "inline" }); });
    expect(host.modeRequests).toEqual(["fullscreen"]);
    await act(async () => { host.clients[0]?.onhostcontextchanged?.({ displayMode: "inline" }); });
    expect(host.modeRequests).toEqual(["fullscreen"]);
});

test("Workspace does not retry fullscreen after Host rejection without explicit action", async () => {
    host.availableDisplayModes = ["fullscreen"];
    host.modeAccepted = false;
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: "ctx-denied", instance: "demo", cursor: 1, agentBusy: false,
            presentation: { work: [], background: [] },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: {
        "portable-devshell/mcpapp": { ctxId: "ctx-denied", token: "valid-denied-test-private-token",
            liveBaseUrl: "https://devshell.example/api/live/demo/workspace" },
    } }); });
    await vi.waitFor(() => expect(host.modeRequests).toEqual(["fullscreen"]));
    expect(container!.textContent).toContain("inline");
    await act(async () => { host.clients[0]?.onhostcontextchanged?.({ displayMode: "inline" }); });
    expect(host.modeRequests).toEqual(["fullscreen"]);
    host.modeAccepted = true;
    const request = Array.from(container!.querySelectorAll("button"))
        .find((element) => element.textContent === "Open fullscreen");
    expect(request).toBeDefined();
    await act(async () => { request?.click(); });
    expect(host.modeRequests).toEqual(["fullscreen", "fullscreen"]);
    expect(host.displayMode).toBe("fullscreen");
});

test("Inline bootstraps private capability before tool result and handles approvals and waits", async () => {
    host.availableDisplayModes = ["fullscreen"];
    host.bootstrapCapability = { ctxId: "ctx-inline", token: "private-inline-test-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    const state = {
        ctxId: "ctx-inline", instance: "demo", cursor: 7, agentBusy: true,
        presentation: {
            primary: { id: "approval-inline", title: "Approval required", actions: [
                { id: "approve", label: "Approve" },
                { id: "deny", label: "Deny", confirmation: { message: "Reject?" } },
            ] },
            work: [{ id: "goal-inline", title: "Long-running Goal" }],
            background: [{ id: "wait-inline", title: "tmux_run", badge: "Wait · pending" }],
        },
    };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify(state), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="interaction" />); });
    await vi.waitFor(() => expect(container!.textContent).toContain("Approval required"));
    expect(host.bootstrapCalls).toBe(1);
    expect(host.modeRequests).toHaveLength(0);
    expect(container!.textContent).toContain("Wait · pending");
    expect(container!.textContent).not.toContain("Long-running Goal");
    expect(container!.textContent).not.toContain("private-inline-test-token");
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
        .find((entry) => entry.textContent === name)!;
    await act(async () => { button("Deny").click(); });
    expect(host.actions).toHaveLength(0);
    await act(async () => { button("Back").click(); });
    await act(async () => { button("Deny").click(); });
    await act(async () => { button("Confirm Deny").click(); });
    await vi.waitFor(() => expect(host.actions).toHaveLength(1));
    expect(host.actions[0]).toEqual({ name: "mcpapp_action", arguments: {
        ctxId: "ctx-inline", itemId: "approval-inline", actionId: "deny", requestId: expect.any(String),
    } });
});

test("Host fullscreen iframe remount does not reopen a dismissed Context", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    let widgetState: Record<string, unknown> = {};
    Object.assign(window, { openai: {
        get widgetState() { return widgetState; },
        setWidgetState(state: unknown) { widgetState = state as Record<string, unknown>; },
    } });
    host.availableDisplayModes = ["fullscreen"];
    const capability = { ctxId: "ctx-mount-guard", token: "private-test-remount-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 1, agentBusy: false,
            presentation: { work: [], background: [] },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView />); });
        await act(async () => { host.clients.at(-1)?.ontoolresult?.({
            _meta: { "portable-devshell/mcpapp": capability },
        }); });
        await vi.waitFor(() => expect(host.modeRequests).toEqual(["fullscreen"]));
        expect((widgetState.privateContent as Record<string, unknown>)?.portableDevshellFullscreenClaim)
            .toBe("ctx-mount-guard");
        await act(async () => { root?.unmount(); root = undefined; });
        host.displayMode = "inline";
        root = createRoot(container);
        await act(async () => { root?.render(<AppView />); });
        await vi.waitFor(() => expect(container!.textContent).toContain("ctx-mount-guard"));
        expect(host.modeRequests).toEqual(["fullscreen"]);
    } finally {
        Object.assign(window, { openai: previousOpenai });
    }
});

test("Blocking question remains answerable from explicit fullscreen fallback when Host cannot mount inline", async () => {
    const capability = { ctxId: "ctx-pending", token: "private-fallback-test-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    const question = {
        id: "pending-question", title: "Question for you", detail: "Deploy now?",
        actions: [{ id: "question-answer-choice", label: "Answer",
            input: { kind: "choice", choices: [{ id: "Yes", label: "Yes" }] } }],
    };
    host.actionResult = { status: "applied", detached: true, question: "Deploy now?", answer: "Yes" };
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 7, agentBusy: true,
            presentation: { primary: question, work: [], background: [] },
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: {
        "portable-devshell/mcpapp": capability,
    } }); });
    await vi.waitFor(() => expect(container!.textContent).toContain("Answer here if Inline is unavailable"));
    const button = (name: string) => Array.from(container!.querySelectorAll("button"))
        .find((element) => element.textContent === name);
    expect(button("Yes")).toBeUndefined();
    await act(async () => { button("Answer here if Inline is unavailable")?.click(); });
    expect(container!.textContent).toContain("Deploy now?");
    await act(async () => { button("Yes")?.click(); });
    await vi.waitFor(() => expect(host.actions).toHaveLength(1));
    await vi.waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.actions[0]?.name).toBe("mcpapp_action");
    expect(JSON.stringify(host.sent[0])).toContain("Deploy now?");
    expect(JSON.stringify(host.sent[0])).toContain("Yes");
});

test("ToolCall inline is two lines and never loads Context Snapshot, Wait or Approval", async () => {
    const capability = { ctxId: "ctx-toolcall", token: "private-toolcall-test-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    globalThis.fetch = vi.fn(() => { throw new Error("Inline must never request Context Live data"); }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="toolcall" />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({ _meta: {
        "portable-devshell/mcpapp": capability,
    } }); });
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(host.bootstrapCalls).toBe(0);
    expect(host.modeRequests).toHaveLength(0);
    expect(host.resizeSubscriptions).toBe(1);

    await act(async () => {
        host.clients[0]?.ontoolinput?.({ arguments: { files: [{ path: "src/widget.ts" }], purpose: "Read source" } });
        host.clients[0]?.ontoolresult?.({
            _meta: { "portable-devshell/toolcall": { name: "file_read" } },
            structuredContent: { files: [{ path: "src/widget.ts",
                content: "1:Safe result\n2:password=hidden-token" }] },
        });
    });
    expect(container!.textContent).toContain("file_read");
    expect(container!.textContent).toContain("Completed");
    expect(container!.textContent).toContain("src/widget.ts");
    const expand = container!.querySelector<HTMLElement>(".toolcall-card");
    expect(expand).not.toBeNull();
    expect(expand?.querySelector(".toolcall-compact")?.getAttribute("aria-expanded")).toBe("false");
    expect(expand?.querySelectorAll(".toolcall-compact > *")).toHaveLength(2);
    expect(container!.querySelector(".toolcall-result-text")).toBeNull();
    expect(container!.textContent).not.toContain("Wait · active");
    expect(container!.textContent).not.toContain("Approval required");
    await act(async () => { expand?.querySelector<HTMLButtonElement>(".toolcall-compact")?.click(); });
    expect(expand?.querySelector(".toolcall-compact")?.getAttribute("aria-expanded")).toBe("true");
    expect(container!.querySelector(".tc-code")?.textContent).toContain("Safe result");
    expect(container!.textContent).not.toContain("hidden-token");
    expect(container!.textContent).toContain("[redacted]");
    expect(container!.textContent).not.toContain("private-toolcall-test-token");

    expect(globalThis.fetch).not.toHaveBeenCalled();
    await act(async () => { expand?.querySelector<HTMLButtonElement>(".toolcall-compact")?.click(); });
    expect(container!.querySelector(".toolcall-result-text")).toBeNull();
});

test("ChatGPT static ToolCall restores from response metadata after an iframe remount", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    const globals = {
        toolInput: { purpose: "Inspect repo", command: "git status --short" },
        toolOutput: { exitCode: 0, durationMs: 11, stdout: " M src/App.tsx\n" },
        toolResponseMetadata: {
            "portable-devshell/toolcall": { name: "bash_run" },
            "portable-devshell/mcpapp": {
                ctxId: "ctx-static", token: "private-static-test-token",
                liveBaseUrl: "https://devshell.example/api/live/test/workspace",
            },
        },
    };
    Object.assign(window, { openai: globals });
    globalThis.fetch = vi.fn(() => { throw new Error("Static Widget cannot fetch"); }) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="toolcall" />); });
        expect(container.textContent).toContain("Inspect repo");
        expect(container.textContent).toContain("bash_run");
        expect(container.querySelectorAll(".toolcall-compact > *")).toHaveLength(2);
        expect(container.querySelector(".toolcall-result-text")).toBeNull();
        expect(host.clients).toHaveLength(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
        await act(async () => { container?.querySelector<HTMLButtonElement>(".toolcall-compact")?.click(); });
        expect(container.textContent).toContain("M src/App.tsx");
        expect(container.textContent).not.toContain("private-static-test-token");

        await act(async () => { root?.unmount(); root = undefined; });
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="toolcall" />); });
        expect(container.textContent).toContain("Inspect repo");
        expect(container.querySelector(".toolcall-result-text")).toBeNull();
        expect(host.clients).toHaveLength(0);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
        Object.assign(window, { openai: previousOpenai });
    }
});

test("per-tool CatDesk-style metadata restores and updates without Host toolOutput or SDK", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    const previousName = document.documentElement.getAttribute("data-tool-name");
    const payload = (content: string) => ({
        "portable-devshell/widgetPayload": {
            schema: "portable-devshell.toolcall.v1",
            toolName: "file_read", isError: false,
            input: { files: [{ path: "src/widget.ts" }], purpose: "Read widget code" },
            output: { files: [{ path: "src/widget.ts", content }] },
        },
    });
    const oldGlobals = { toolResponseMetadata: payload("1:const oldState = true;"),
        toolOutput: { files: [{ path: "wrong.ts", content: "stale toolOutput" }] } };
    const newGlobals = { toolResponseMetadata: payload("1:const newState = true;") };
    document.documentElement.setAttribute("data-tool-name", "file_read");
    Object.assign(window, { openai: oldGlobals });
    globalThis.fetch = vi.fn(() => { throw new Error("Static widget must not fetch"); }) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="toolcall" />); });
        expect(container.querySelector(".toolcall-description")?.textContent).toContain("src/widget.ts");
        expect(container.querySelectorAll(".toolcall-compact > *")).toHaveLength(2);
        expect(host.clients).toHaveLength(0);
        await act(async () => { container?.querySelector<HTMLButtonElement>(".toolcall-compact")?.click(); });
        expect(container.querySelector(".tc-code")?.textContent).toContain("oldState");
        expect(container.textContent).not.toContain("stale toolOutput");
        await act(async () => { window.dispatchEvent(new CustomEvent("openai:set_globals", {
            detail: { globals: newGlobals },
        })); });
        expect(container.querySelector(".tc-code")?.textContent).toContain("newState");
        expect(container.querySelector(".tc-code")?.textContent).not.toContain("oldState");
        expect(globalThis.fetch).not.toHaveBeenCalled();
        Object.assign(window, { openai: newGlobals });
        await act(async () => { root?.unmount(); root = undefined; });
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="toolcall" />); });
        expect(container.querySelector(".toolcall-description")?.textContent).toContain("src/widget.ts");
        expect(container.querySelector(".toolcall-compact")?.getAttribute("aria-expanded")).toBe("false");
        expect(host.clients).toHaveLength(0);
    } finally {
        Object.assign(window, { openai: previousOpenai });
        if (previousName === null) document.documentElement.removeAttribute("data-tool-name");
        else document.documentElement.setAttribute("data-tool-name", previousName);
    }
});

test("ToolCall Inline preserves a native image after metadata-only Host globals update", async () => {
    const previousOpenai = (window as Window & { openai?: unknown }).openai;
    const previousName = document.documentElement.getAttribute("data-tool-name");
    const content = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+uCPEAAAAASUVORK5CYII=";
    const output = { imageRef: "stored.png", name: "map.png",
        mediaType: "image/png", bytes: 68 };
    const metadata = { "portable-devshell/widgetPayload": {
        schema: "portable-devshell.toolcall.v1", toolName: "artifact_viewImage",
        isError: false, output,
    } };
    const globals = { toolResponseMetadata: metadata };
    document.documentElement.setAttribute("data-tool-name", "artifact_viewImage");
    Object.assign(window, { openai: globals });
    globalThis.fetch = vi.fn(() => { throw new Error("Inline image must not fetch"); }) as typeof fetch;
    try {
        container = document.createElement("div");
        document.body.append(container);
        root = createRoot(container);
        await act(async () => { root?.render(<AppView view="toolcall" />); });
        expect(container.querySelector(".tc-image")).toBeNull();
        await act(async () => { window.dispatchEvent(new MessageEvent("message", {
            source: window.parent, data: {
                method: "ui/notifications/tool-result",
                params: { result: {
                    _meta: { "portable-devshell/toolcall": { name: "artifact_viewImage" } },
                    structuredContent: output,
                    content: [{ type: "image", mimeType: "image/png", data: content }],
                } },
            },
        })); });
        await act(async () => {
            container?.querySelector<HTMLButtonElement>(".toolcall-compact")?.click();
        });
        expect(container.querySelector<HTMLImageElement>(".tc-image img")?.src)
            .toBe(`data:image/png;base64,${content}`);
        await act(async () => { window.dispatchEvent(new CustomEvent("openai:set_globals", {
            detail: { globals },
        })); });
        expect(container.querySelector<HTMLImageElement>(".tc-image img")?.src)
            .toBe(`data:image/png;base64,${content}`);
        expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
        Object.assign(window, { openai: previousOpenai });
        if (previousName === null) document.documentElement.removeAttribute("data-tool-name");
        else document.documentElement.setAttribute("data-tool-name", previousName);
    }
});

test("Workspace toggle updates ToolCall presentation preference without changing tool execution", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="workspace" />); });
    const checkbox = container!.querySelector<HTMLInputElement>(".workspace-setting input");
    expect(checkbox?.checked).toBe(true);
    await act(async () => { checkbox?.click(); });
    expect(checkbox?.checked).toBe(false);
    expect(host.actions).toHaveLength(0);
    expect(host.modeRequests).toHaveLength(0);
    await act(async () => { checkbox?.click(); });
    expect(checkbox?.checked).toBe(true);
});

test("Fullscreen Activity displays audited Context-scoped ToolCall timeline", async () => {
    const capability = { ctxId: "ctx-activity", token: "private-activity-test-token",
        liveBaseUrl: "https://devshell.example/api/live/demo/workspace" };
    const activityRequests: Array<{ url: string; auth: string | null }> = [];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/activity?")) {
            activityRequests.push({ url, auth: new Headers(init?.headers).get("Authorization") });
            const first = url.includes("fromSeq=1");
            return Promise.resolve(new Response(JSON.stringify({
                callId: "call-1",
                stdout: first ? "main\n" : "latest\n",
                stderr: first ? "" : "warning\n",
                ...(first ? { nextSeq: 4 } : {}),
            }), { status: 200 }));
        }
        if (url.includes("/snapshot")) return Promise.resolve(new Response(JSON.stringify({
            ctxId: capability.ctxId, instance: "demo", cursor: 19, agentBusy: false,
            presentation: { work: [], background: [] },
            activity: [{ callId: "call-1", name: "bash_run", state: "completed",
                exitCode: 0, at: "2026-10-12T16:00:00Z", purpose: "Check workspace state",
                target: "git status --short", output: { exitCode: 0, stdoutBytes: 12, stderrBytes: 8 } },
                { callId: "call-2", name: "tmux_run", state: "completed", at: "2026-10-12T16:01:00Z",
                    taskId: "task-1", target: "pnpm build", summary: "exit 0",
                    output: { task: { id: "task-1", status: "running" }, output: ["Starting build"] } },
                { callId: "call-3", name: "tmux_read", state: "completed", at: "2026-10-12T16:02:00Z",
                    taskId: "task-1", target: "task-1",
                    output: { task: { id: "task-1", status: "0" }, output: ["Build complete"] } },
                { callId: "call-4", name: "mcpapp_open", state: "completed", at: "2026-10-12T16:03:00Z" }],
        }), { status: 200 }));
        return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
        });
    }) as typeof fetch;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="workspace" />); });
    await act(async () => { host.clients[0]?.ontoolresult?.({
        _meta: { "portable-devshell/mcpapp": capability },
    }); });
    await vi.waitFor(() => expect(container!.textContent).toContain("Workspace ready"));
    const activity = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Activity");
    await act(async () => { activity?.click(); });
    expect(container!.textContent).toContain("Recent ToolCalls");
    expect(container!.textContent).toContain("bash_run");
    expect(container!.textContent).toContain("exit 0");
    expect(container!.textContent).toContain("Check workspace state");
    expect(container!.textContent).toContain("git status --short");
    expect(container!.querySelector(".dashboard-timeline .tc-terminal")).toBeNull();
    expect(activityRequests).toHaveLength(0);
    await act(async () => { container!.querySelector<HTMLButtonElement>(".dashboard-timeline .toolcall-compact")?.click(); });
    await vi.waitFor(() => expect(container!.querySelector(".dashboard-timeline .tc-terminal pre")?.textContent).toContain("main"));
    expect(container!.querySelector(".dashboard-timeline .tc-terminal pre")?.textContent).toContain("main");
    expect(activityRequests[0]?.url).toContain("/activity?callId=call-1&fromSeq=1&ctxId=ctx-activity");
    expect(activityRequests[0]?.auth).toBe("Bearer private-activity-test-token");
    await act(async () => { container!.querySelector<HTMLButtonElement>(".tc-activity-actions button")?.click(); });
    await vi.waitFor(() => expect(container!.querySelector(".dashboard-timeline .tc-terminal pre")?.textContent).toContain("latest"));
    expect(activityRequests[1]?.url).toContain("fromSeq=4");
    expect(container!.textContent).toContain("warning");
    expect(container!.querySelectorAll(".dashboard-timeline li")).toHaveLength(2);
    expect(container!.textContent).not.toContain("1 transcript reads");
    await act(async () => { container!.querySelectorAll<HTMLButtonElement>(".dashboard-timeline .toolcall-compact")[1]?.click(); });
    expect(container!.textContent).toContain("1 transcript reads");
    expect(container!.querySelectorAll(".dashboard-timeline li")[1]?.querySelector(".tc-terminal pre")?.textContent).toContain("Build complete");
    const internal = Array.from(container!.querySelectorAll(".workspace-setting"))
        .find((item) => item.textContent?.includes("Include polling"))?.querySelector("input");
    await act(async () => { internal?.click(); });
    expect(container!.querySelectorAll(".dashboard-timeline li")).toHaveLength(4);
    await act(async () => { internal?.click(); });
    expect(container!.querySelectorAll(".dashboard-timeline li")).toHaveLength(2);
    const history = container!.querySelector<HTMLInputElement>(".dashboard-activity-head input");
    await act(async () => { history?.click(); });
    expect(container!.querySelector(".dashboard-timeline")).toBeNull();
    await act(async () => { history?.click(); });
    expect(container!.textContent).toContain("git status --short");
    expect(container!.textContent).not.toContain("private-activity-test-token");
});

test("Workspace Close requests Host teardown without reopening the dismissed app", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<AppView view="workspace" />); });
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close workspace"]');
    expect(close).not.toBeNull();
    await act(async () => { close?.click(); });
    expect(host.teardownRequests).toBe(1);
    expect(close?.textContent).toContain("Closing");
    await act(async () => { host.clients[0]?.onclose?.(); });
    expect(container.textContent).toContain("Disconnected");
    expect(host.clients).toHaveLength(1);
});

test("File and custom tool results have readable multiline details and generic fallback", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<ToolCallCard enabled onEnabledChange={() => undefined}
        result={{ name: "file_read", isError: false, output: {
            files: [{ path: "/etc/os-release", content: "1:NAME=Arch Linux\n2:ID=arch" }],
        } }} />); });
    expect(container.querySelector(".tc-code")).toBeNull();
    await act(async () => { container?.querySelector(".toolcall-compact")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container.querySelector(".tc-file-header")?.textContent).toContain("/etc/os-release");
    expect(container.querySelectorAll(".tc-code-line")).toHaveLength(2);
    expect(container.querySelector(".tc-code-line code")?.textContent).toBe("NAME=Arch Linux");
    expect(container.querySelector(".tc-gutter")?.textContent).toBe("1");
    expect(container.querySelector(".tc-code")?.textContent).not.toContain('"content":');
    await act(async () => { root?.render(<ToolCallCard enabled onEnabledChange={() => undefined}
        result={{ name: "custom_plugin", isError: false, output: {
            operation: "inspect", nested: { token: "must-stay-private", passed: true },
        } }} />); });
    expect(container.querySelector(".tc-fields")?.textContent).toContain("inspect");
    expect(container.textContent).not.toContain("must-stay-private");
});

test("ToolCall summary understands DevShell file arrays, shell exit status and protected credentials", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => { root?.render(<ToolCallCard enabled
        onEnabledChange={() => undefined}
        input={{ command: "curl -H 'Authorization: Bearer my-secret-token' https://example.org",
            purpose: "Verify read-only network access" }}
        result={{ name: "bash_run", isError: false,
            output: { exitCode: 0, durationMs: 18, stdout: "Probe succeeded" } }} />); });
    expect(container!.textContent).toContain("Verify read-only network access");
    expect(container!.textContent).toContain("18ms");
    expect(container!.querySelector(".tc-terminal")).toBeNull();
    await act(async () => { container!.querySelector(".toolcall-compact")?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    expect(container!.querySelector(".tc-stats")?.textContent).toContain("Exit0");
    expect(container!.querySelector(".tc-terminal pre")?.textContent).toContain("Probe succeeded");
    expect(container!.textContent).not.toContain("my-secret-token");
});

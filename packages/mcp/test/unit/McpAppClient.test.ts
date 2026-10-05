import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { McpAppSnapshot } from "../../src/mcpapp/model/Contract.ts";
import { McpAppConnection } from "../../src/mcpapp/app/client/Connection.ts";
import {
    pendingDirectives,
    McpAppReentry,
} from "../../src/mcpapp/app/client/Reentry.ts";
import { renderMcpApp } from "../../src/mcpapp/app/client/Cards.ts";
import { McpAppSession } from "../../src/mcpapp/app/client/Session.ts";
import { McpAppPresentation } from "../../src/mcpapp/app/client/Presentation.ts";
import type {
    McpAppDisplayMode,
    McpAppHostContext,
    McpAppWidgetState,
} from "../../src/mcpapp/app/client/Host.ts";
import { McpAppHost } from "../../src/mcpapp/app/client/Host.ts";
import { McpAppView } from "../../src/mcpapp/app/client/View.ts";
import { McpAppRuntime } from "../../src/mcpapp/app/client/Runtime.ts";
import type { McpAppActionRequest } from "../../src/mcpapp/model/Contract.ts";

class CardRoot extends EventTarget {
    innerHTML = "";
    readonly ownerDocument = { activeElement: null };
    querySelectorAll(): HTMLElement[] {
        return [];
    }
    emit(type: string, target: unknown): void {
        const event = new Event(type, { cancelable: true });
        Object.defineProperty(event, "target", { value: target });
        this.dispatchEvent(event);
    }
}

function cardButton(
    dataset: Record<string, string>,
    selectors: string[],
    attributes: string[] = [],
) {
    const button = {
        dataset,
        hasAttribute: (name: string) => attributes.includes(name),
        closest: (selector: string): unknown =>
            selectors.includes(selector) ? button : null,
    };
    return button;
}

test("official SDK size tracking deduplicates dimensions and disposes observers and queued notifications across reconnect and close", async t => {
    const sizes: Array<Parameters<App["sendSizeChanged"]>[0]> = [];
    const displayRequests: Array<Parameters<App["requestDisplayMode"]>> = [];
    const frames: Array<() => void> = [];
    const observers: TestResizeObserver[] = [];
    let height = 100;
    class TestResizeObserver {
        disconnected = false;
        readonly targets: unknown[] = [];
        constructor(readonly callback: () => void) { observers.push(this); }
        observe(target: unknown): void { this.targets.push(target); }
        disconnect(): void { this.disconnected = true; }
    }
    class TestApp extends App {
        override async connect(): Promise<void> { }
        async close(): Promise<void> { }
        override async sendSizeChanged(params: Parameters<App["sendSizeChanged"]>[0]): Promise<void> { sizes.push(params); }
        override async requestDisplayMode(...args: Parameters<App["requestDisplayMode"]>): ReturnType<App["requestDisplayMode"]> { displayRequests.push(args); return { mode: args[0].mode }; }
    }
    const element = { style: { height: "" }, getBoundingClientRect: () => ({ height }) };
    const globals = {
        window: { innerWidth: 800 },
        document: { documentElement: element, body: {} },
        ResizeObserver: TestResizeObserver,
        requestAnimationFrame: (callback: FrameRequestCallback) => { frames.push(() => callback(0)); return frames.length; },
        __portableDevshellMcpApps: { App: TestApp, applyDocumentTheme: () => undefined, applyHostFonts: () => undefined, applyHostStyleVariables: () => undefined },
    };
    for (const [key, value] of Object.entries(globals)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        t.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    }
    const host = new McpAppHost("test");
    await host.connect();
    assert.equal(await host.requestDisplayMode("pip"), "pip");
    assert.deepEqual(displayRequests, [[{ mode: "pip" }, { timeout: 1_000 }]]);
    frames.splice(0).forEach(frame => frame());
    assert.deepEqual(sizes, [{ width: 800, height: 100 }]);
    assert.equal(observers[0]!.targets.length, 2);
    observers[0]!.callback();
    observers[0]!.callback();
    assert.equal(frames.length, 1);
    frames.splice(0).forEach(frame => frame());
    assert.equal(sizes.length, 1);
    height = 120;
    observers[0]!.callback();
    frames.splice(0).forEach(frame => frame());
    assert.deepEqual(sizes.at(-1), { width: 800, height: 120 });
    height = 140;
    observers[0]!.callback();
    await host.reconnect();
    assert.equal(observers.length, 2);
    assert.equal(observers[0]!.disconnected, true);
    frames.splice(0).forEach(frame => frame());
    assert.deepEqual(sizes, [{ width: 800, height: 100 }, { width: 800, height: 120 }, { width: 800, height: 140 }]);
    height = 160;
    observers[1]!.callback();
    await host.close();
    assert.equal(observers[1]!.disconnected, true);
    frames.splice(0).forEach(frame => frame());
    assert.equal(sizes.length, 3);
});

function snapshot(): McpAppSnapshot {
    return {
        ctxId: "ctx-one",
        instance: "alpha",
        cursor: 7,
        agentBusy: false,
        presentation: {
            primary: {
                kind: "decision",
                id: "decision-1",
                title: "Review",
                actions: [{ id: "approve", label: "Approve", tone: "primary" }],
            },
            work: [],
            background: [],
        },
        modelContext: {
            content: [{ type: "text", text: "authoritative" }],
            structuredContent: { portableDevshellMcpApp: { version: 2 } },
        },
        reentry: { pending: false },
    };
}

class RuntimeTestHost extends McpAppHost {
    bootstrap: unknown;
    toolResult?: (result: unknown) => void;
    cancelled?: (params: { reason?: string }) => void;
    override set ontoolresult(handler: ((result: unknown) => void) | undefined) { this.toolResult = handler; }
    override set ontoolcancelled(handler: ((params: { reason?: string }) => void) | undefined) { this.cancelled = handler; }
    override async connect(): Promise<void> { this.toolResult?.(this.bootstrap); }
    override async updateModelContext(): Promise<unknown> { return undefined; }
}

function runtimeTestHost(context: TestContext, cleanup: () => Promise<void>): RuntimeTestHost {
    context.after(cleanup);
    const globals = {
        window: new EventTarget(),
        __portableDevshellMcpApps: { App, applyDocumentTheme: () => undefined, applyHostFonts: () => undefined, applyHostStyleVariables: () => undefined },
    };
    for (const [key, value] of Object.entries(globals)) {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, key);
        Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
        context.after(() => { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); });
    }
    return new RuntimeTestHost("test");
}

test("delayed bootstrap shows Context waiting, then authorization waiting without premature MCP requests", async context => {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const host = runtimeTestHost(context, () => runtime.destroy());
    const requests: string[] = [];
    context.mock.method(host.app, "callServerTool", async (request: { name: string }) => {
        requests.push(request.name);
        throw new Error("Bootstrap must not call MCP without authorization");
    });
    const status = { textContent: "" };
    const runtime = new McpAppRuntime({ version: "test", host, root: new CardRoot() as unknown as HTMLElement, status: status as HTMLElement });
    const starting = runtime.start();
    await Promise.resolve();
    context.mock.timers.tick(300);
    await starting;
    assert.equal(status.textContent, "Waiting for McpApp context");
    assert.deepEqual(requests, []);
    host.toolResult?.({ structuredContent: { ctxId: "ctx-one" } });
    assert.equal(status.textContent, "Waiting for McpApp authorization");
    assert.deepEqual(requests, []);
});

test("non-user cancellation preserves held watch while user stop yields and refreshes", async context => {
    const host = runtimeTestHost(context, () => runtime.destroy());
    host.bootstrap = { structuredContent: { ctxId: "ctx-one" }, _meta: { "portable-devshell/mcpapp": { token: "token-one" } } };
    const requests: Array<{ name: string; arguments: Record<string, unknown> }> = [];
    const signals: AbortSignal[] = [];
    let aborts = 0;
    let secondWatchReady!: () => void;
    const secondWatch = new Promise<void>(resolve => { secondWatchReady = resolve; });
    context.mock.method(host.app, "callServerTool", (request: { name: string; arguments: Record<string, unknown> }, options?: { signal?: AbortSignal }) => {
        requests.push(request);
        if (request.name === "mcpapp_watch") {
            assert.ok(options?.signal);
            const signal = options.signal;
            signals.push(signal);
            if (signals.length === 2) secondWatchReady();
            return new Promise<{ structuredContent?: unknown }>((_resolve, reject) => {
                signal.addEventListener("abort", () => { aborts += 1; reject(signal.reason); }, { once: true });
            });
        }
        if (request.name === "mcpapp_snapshot") return Promise.resolve({ structuredContent: snapshot() });
        if (request.name === "mcpapp_reentry") return Promise.resolve({ structuredContent: {} });
        throw new Error(`Unexpected MCP request: ${request.name}`);
    });
    const runtime = new McpAppRuntime({ version: "test", host, root: new CardRoot() as unknown as HTMLElement, status: { textContent: "" } as HTMLElement });
    await runtime.start();
    assert.equal(signals.length, 1);
    host.cancelled?.({ reason: "test cancellation" });
    await Promise.resolve();
    assert.equal(signals[0]!.aborted, false);
    assert.equal(aborts, 0);
    assert.deepEqual(requests.map(request => request.name), ["mcpapp_snapshot", "mcpapp_watch"]);
    host.cancelled?.({ reason: "user stopped" });
    await secondWatch;
    assert.equal(signals[0]!.aborted, true);
    assert.equal(aborts, 1);
    assert.deepEqual(requests.map(request => request.name), ["mcpapp_snapshot", "mcpapp_watch", "mcpapp_reentry", "mcpapp_snapshot", "mcpapp_watch"]);
    assert.equal(requests[2]!.arguments.action, "yield");
});

test("a held watch with a newer cursor applies after a later human action", async context => {
    const host = runtimeTestHost(context, () => runtime.destroy());
    host.bootstrap = { structuredContent: { ctxId: "ctx-one" }, _meta: { "portable-devshell/mcpapp": { token: "token-one" } } };
    const root = new CardRoot();
    let resolveWatch!: (result: { structuredContent: { snapshot: McpAppSnapshot; cursor: number } }) => void;
    let actionContextReady!: () => void;
    const actionContext = new Promise<void>(resolve => { actionContextReady = resolve; });
    let nextWatchReady!: () => void;
    const nextWatch = new Promise<void>(resolve => { nextWatchReady = resolve; });
    let watchCount = 0;
    context.mock.method(host, "updateModelContext", async () => {
        if (runtime.view.snapshot?.presentation.primary?.title === "Action applied") actionContextReady();
    });
    context.mock.method(host.app, "callServerTool", (request: { name: string }, options?: { signal?: AbortSignal }) => {
        if (request.name === "mcpapp_snapshot") return Promise.resolve({ structuredContent: snapshot() });
        if (request.name === "mcpapp_action") {
            const updated = snapshot();
            updated.presentation.primary!.title = "Action applied";
            return Promise.resolve({ structuredContent: { status: "applied", snapshot: updated } });
        }
        assert.equal(request.name, "mcpapp_watch");
        watchCount += 1;
        if (watchCount === 2) nextWatchReady();
        return new Promise<{ structuredContent: { snapshot: McpAppSnapshot; cursor: number } }>((resolve, reject) => {
            resolveWatch = resolve;
            options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        });
    });
    const runtime = new McpAppRuntime({ version: "test", host, root: root as unknown as HTMLElement, status: { textContent: "" } as HTMLElement });
    await runtime.start();
    root.emit("click", cardButton({ item: "decision-1", action: "approve" }, ["[data-action]"]));
    await actionContext;
    assert.equal(runtime.view.snapshot?.presentation.primary?.title, "Action applied");
    const updated = snapshot();
    updated.cursor = 8;
    updated.presentation.primary!.title = "New question after action";
    resolveWatch({ structuredContent: { snapshot: updated, cursor: updated.cursor } });
    await nextWatch;
    assert.equal(runtime.view.snapshot?.cursor, 8);
    assert.equal(runtime.view.snapshot?.presentation.primary?.title, "New question after action");
});

test("direct deadlines fall back to MCP, retain same-endpoint backoff, and reset on authoritative Context replacement", async t => {
    const session = new McpAppSession();
    let widgetState: McpAppWidgetState = { privateContent: {} };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", { configurable: true, value: { openai: {
        get widgetState() { return widgetState; },
        setWidgetState: (state: McpAppWidgetState) => { widgetState = state; },
    } } });
    t.after(() => { if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow); else Reflect.deleteProperty(globalThis, "window"); });
    const capability = { token: "token-one", liveBaseUrl: "https://live.example/workspace" };
    session.acceptToolResult({ structuredContent: { ctxId: "ctx-one" }, _meta: { "portable-devshell/mcpapp": capability } });
    const deadlines: number[] = [];
    const controllers: AbortController[] = [];
    t.mock.method(AbortSignal, "timeout", (duration: number) => {
        deadlines.push(duration);
        const controller = new AbortController();
        controllers.push(controller);
        return controller.signal;
    });
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const directRequests: string[] = [];
    const toolRequests: Array<{ name: string; timeout?: number }> = [];
    const fetcher: typeof fetch = async (url, options) => {
        directRequests.push(String(url));
        return await new Promise<Response>((_resolve, reject) => {
            options!.signal!.addEventListener("abort", () => reject(options!.signal!.reason), { once: true });
        });
    };
    const connection = new McpAppConnection(session, {
        callServerTool: async (request, options) => {
            toolRequests.push({ name: request.name, timeout: options?.timeout });
            const current = { ...snapshot(), ctxId: session.state.ctxId };
            return { structuredContent: request.name === "mcpapp_watch" ? { snapshot: current, cursor: current.cursor } : current };
        },
    }, fetcher);
    const initial = connection.snapshot();
    assert.deepEqual(deadlines, [5_000]);
    controllers[0]!.abort(new DOMException("Deadline", "TimeoutError"));
    assert.equal((await initial).ctxId, "ctx-one");
    assert.equal((widgetState.privateContent!.portableDevshellMcpApp as Record<string, unknown>).liveBaseUrl, undefined);
    session.acceptToolResult({ structuredContent: { ctxId: "ctx-one" }, _meta: { "portable-devshell/mcpapp": capability } });
    await connection.snapshot();
    assert.equal(directRequests.length, 1);
    assert.equal((widgetState.privateContent!.portableDevshellMcpApp as Record<string, unknown>).liveBaseUrl, undefined);
    now += 30_001;
    const watch = connection.watch();
    assert.deepEqual(deadlines, [5_000, 30_000]);
    controllers[1]!.abort(new DOMException("Deadline", "TimeoutError"));
    await watch;
    session.acceptToolResult({ structuredContent: { ctxId: "ctx-two" }, _meta: { "portable-devshell/mcpapp": capability } });
    const replacement = connection.snapshot();
    assert.equal(directRequests.length, 3);
    controllers[2]!.abort(new DOMException("Deadline", "TimeoutError"));
    assert.equal((await replacement).ctxId, "ctx-two");
    assert.deepEqual(toolRequests, [
        { name: "mcpapp_snapshot", timeout: 30_000 },
        { name: "mcpapp_snapshot", timeout: 30_000 },
        { name: "mcpapp_watch", timeout: 30_000 },
        { name: "mcpapp_snapshot", timeout: 30_000 },
    ]);
});

test("MCP heartbeat advances watch cursor without a fabricated snapshot and authoritative replacement resets it", async () => {
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "token-one" });
    const calls: Array<{ ctxId: unknown; cursor: unknown }> = [];
    const connection = new McpAppConnection(session, {
        callServerTool: async request => {
            calls.push({ ctxId: request.arguments.ctxId, cursor: request.arguments.cursor });
            return { structuredContent: { cursor: request.arguments.ctxId === "ctx-one" ? 11 : 1 } };
        },
    });
    await connection.watch();
    assert.equal(connection.cursor, 11);
    await connection.watch();
    session.configure("ctx-two", { token: "token-two" }, true);
    assert.equal(connection.cursor, 0);
    await connection.watch();
    assert.equal(connection.cursor, 1);
    assert.deepEqual(calls, [
        { ctxId: "ctx-one", cursor: 0 },
        { ctxId: "ctx-one", cursor: 11 },
        { ctxId: "ctx-two", cursor: 0 },
    ]);
});

test("McpAppConnection sends only the generic mcpapp_action request and fences context changes", async () => {
    const calls: Array<{ name: string; arguments: Record<string, unknown> }> =
        [];
    let resolveCall!: (value: { structuredContent: unknown }) => void;
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "capability" });
    const app = {
        callServerTool: (request: {
            name: string;
            arguments: Record<string, unknown>;
        }) => {
            calls.push(request);
            return new Promise<{ structuredContent: unknown }>((resolve) => {
                resolveCall = resolve;
            });
        },
    };
    const connection = new McpAppConnection(session, app);
    const pending = connection.action({
        itemId: "decision-1",
        actionId: "approve",
        input: "yes",
    });
    assert.deepEqual(calls[0], {
        name: "mcpapp_action",
        arguments: {
            ctxId: "ctx-one",
            token: "capability",
            itemId: "decision-1",
            actionId: "approve",
            input: "yes",
        },
    });
    session.configure("ctx-two");
    resolveCall({
        structuredContent: { status: "applied", snapshot: snapshot() },
    });
    await assert.rejects(pending, /Context changed during request/u);
    assert.deepEqual(
        calls.map((call) => call.name),
        ["mcpapp_action"],
    );
});

test("stale live HTTP response cannot fall back or advance the replacement Context cursor", async () => {
    let resolveFetch!: (response: Response) => void;
    const mcpCalls: string[] = [];
    const session = new McpAppSession();
    session.configure("ctx-one", {
        token: "capability",
        liveBaseUrl: "https://workspace.test",
    });
    const connection = new McpAppConnection(
        session,
        {
            callServerTool: async (request) => {
                mcpCalls.push(request.name);
                return { structuredContent: snapshot() };
            },
        },
        async () => await new Promise<Response>((resolve) => {
            resolveFetch = resolve;
        }),
    );
    connection.acceptSnapshot({ ...snapshot(), cursor: 41 });
    const pending = connection.snapshot();
    session.configure("ctx-two");
    assert.equal(connection.cursor, 0);
    resolveFetch(new Response(JSON.stringify(snapshot())));
    await assert.rejects(pending, /Context changed during request/u);
    assert.deepEqual(mcpCalls, []);
    assert.equal(connection.cursor, 0);
});

test("authoritative tool result replaces an authorized Context and fences prior work from stale globals", async () => {
    let resolveCall!: (value: { structuredContent: unknown }) => void;
    const session = new McpAppSession();
    session.configure("ctx-old", { token: "old-capability" });
    session.establishAuthorization(session.generation, "ctx-old");
    const connection = new McpAppConnection(session, {
        callServerTool: () =>
            new Promise((resolve) => {
                resolveCall = resolve;
            }),
    });
    connection.acceptSnapshot({ ...snapshot(), ctxId: "ctx-old", cursor: 41 });
    const pending = connection.action({
        itemId: "decision-old",
        actionId: "approve",
    });

    assert.equal(
        session.acceptToolResult({
            structuredContent: { ctxId: "ctx-new" },
            _meta: {
                "portable-devshell/mcpapp": { token: "new-capability" },
            },
        }),
        true,
    );
    assert.equal(session.state.ctxId, "ctx-new");
    assert.equal(connection.cursor, 0);
    assert.equal(
        session.acceptGlobals({
            toolOutput: { ctxId: "ctx-old" },
            toolResponseMetadata: {
                "portable-devshell/mcpapp": { token: "stale-capability" },
            },
        }),
        false,
    );
    assert.equal(session.state.ctxId, "ctx-new");

    resolveCall({
        structuredContent: {
            status: "applied",
            snapshot: { ...snapshot(), ctxId: "ctx-old" },
        },
    });
    await assert.rejects(pending, /Context changed during request/u);
    assert.equal(connection.cursor, 0);
});

test("mcpapp_action rejects MCP error envelopes", async () => {
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "capability" });
    const connection = new McpAppConnection(session, {
        callServerTool: async () => ({
            isError: true,
            structuredContent: { status: "applied", snapshot: snapshot() },
        }),
    });
    await assert.rejects(
        connection.action({ itemId: "decision-1", actionId: "approve" }),
        /tool request failed/u,
    );
});

test("snapshot directives and action effects with the same id are delivered once without mutation", () => {
    const current = snapshot();
    const directive = {
        kind: "reentry",
        intent: "goal-resume",
        sourceId: "goal-1",
        id: "action-1",
    } as const;
    current.reentry.directives = [directive];
    assert.deepEqual(pendingDirectives(current, directive), [directive]);
    assert.equal(current.reentry.directives.length, 1);
});

test("stable directive receipt identity prevents duplicate delivery after remount", async () => {
    const requests: Array<{
        name: string;
        arguments: Record<string, unknown>;
    }> = [];
    let claimed = false;
    const app = {
        callServerTool: async (request: {
            name: string;
            arguments: Record<string, unknown>;
        }) => {
            requests.push(request);
            const action = request.arguments.action;
            if (action === "claim") {
                if (claimed) return { structuredContent: { claimed: false } };
                claimed = true;
                return {
                    structuredContent: {
                        claimed: true,
                        delivery: {
                            modelContext: snapshot().modelContext,
                            message: "Continue",
                        },
                    },
                };
            }
            if (action === "validate")
                return { structuredContent: { valid: true } };
            if (action === "attempt")
                return { structuredContent: { attempted: true } };
            return { structuredContent: {} };
        },
    };
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "capability" });
    const connection = new McpAppConnection(session, app);
    let sent = 0;
    const host = {
        updateModelContext: async () => undefined,
        sendMessage: async () => {
            sent += 1;
            return { isError: false };
        },
    } as unknown as McpAppHost;
    const directive = {
        kind: "reentry",
        intent: "automatic",
        id: "stable-7",
    } as const;
    const refresh = async () => snapshot();
    await new McpAppReentry(connection, host).deliver(directive, refresh);
    await new McpAppReentry(connection, host).deliver(directive, refresh);
    assert.equal(sent, 1);
    const reentryCalls = requests.filter(
        (call) => call.name === "mcpapp_reentry",
    );
    assert.deepEqual(
        reentryCalls.map((call) => call.arguments.action),
        ["claim", "validate", "attempt", "report", "claim"],
    );
    assert.deepEqual(
        reentryCalls.map((call) => call.arguments.claimId),
        Array(5).fill("workspace-action-stable-7"),
    );
    assert.deepEqual(
        reentryCalls.map((call) => call.arguments.directiveId),
        Array(5).fill("stable-7"),
    );
});

test("automatic directives without persistent ids can deliver successive rounds for the same source", async () => {
    const requests: Array<{
        name: string;
        arguments: Record<string, unknown>;
    }> = [];
    let sent = 0;
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "capability" });
    const connection = new McpAppConnection(session, {
        callServerTool: async (request) => {
            requests.push(request);
            switch (request.arguments.action) {
                case "claim":
                    return {
                        structuredContent: {
                            claimed: true,
                            delivery: {
                                modelContext: snapshot().modelContext,
                                message: "Next round",
                            },
                        },
                    };
                case "validate":
                    return { structuredContent: { valid: true } };
                case "attempt":
                    return { structuredContent: { attempted: true } };
                default:
                    return { structuredContent: {} };
            }
        },
    });
    const host = {
        updateModelContext: async () => undefined,
        sendMessage: async () => {
            sent += 1;
            return { isError: false };
        },
    } as unknown as McpAppHost;
    const reentry = new McpAppReentry(connection, host);
    const directive = {
        kind: "reentry",
        intent: "automatic",
        sourceId: "goal-1",
    } as const;
    await reentry.deliver(directive, async () => snapshot());
    await reentry.deliver(directive, async () => snapshot());
    assert.equal(sent, 2);
    assert.equal(
        requests.filter((request) => request.arguments.action === "attempt")
            .length,
        2,
    );
    assert.equal(
        requests.filter((request) => request.arguments.action === "claim")
            .length,
        2,
    );
    assert.ok(
        requests.every((request) => !("directiveId" in request.arguments)),
    );
});

test("reentry stops at a Context replacement during model-context handoff and never settles the old claim on the new Context", async () => {
    const requests: Array<{
        name: string;
        arguments: Record<string, unknown>;
    }> = [];
    const session = new McpAppSession();
    session.configure("ctx-old", { token: "old-capability" });
    const connection = new McpAppConnection(session, {
        callServerTool: async (request) => {
            requests.push(request);
            if (request.arguments.action === "claim")
                return {
                    structuredContent: {
                        claimed: true,
                        delivery: {
                            modelContext: snapshot().modelContext,
                            message: "Continue",
                        },
                    },
                };
            if (request.arguments.action === "validate")
                return { structuredContent: { valid: true } };
            return { structuredContent: {} };
        },
    });
    let sent = 0;
    const host = {
        updateModelContext: async () => {
            session.configure("ctx-new", { token: "new-capability" }, true);
        },
        sendMessage: async () => {
            sent += 1;
            return { isError: false };
        },
    } as unknown as McpAppHost;
    const refreshed = await new McpAppReentry(connection, host).deliver(
        { kind: "reentry", intent: "automatic", id: "old-directive" },
        async () => ({ ...snapshot(), ctxId: "ctx-new" }),
    );
    assert.equal(sent, 0);
    assert.deepEqual(
        requests.map((request) => [
            request.arguments.action,
            request.arguments.ctxId,
        ]),
        [
            ["claim", "ctx-old"],
            ["validate", "ctx-old"],
        ],
    );
    assert.equal(refreshed.ctxId, "ctx-new");
});

test("concurrent Apps do not release the winning claim when duplicate attempt gate rejects the second", async () => {
    const requests: Array<{
        name: string;
        arguments: Record<string, unknown>;
    }> = [];
    let attempts = 0;
    let releases = 0;
    let reports = 0;
    let releaseSend!: () => void;
    let signalFirstSend!: () => void;
    const firstSendStarted = new Promise<void>((resolve) => {
        signalFirstSend = resolve;
    });
    const app = {
        callServerTool: async (request: {
            name: string;
            arguments: Record<string, unknown>;
        }) => {
            requests.push(request);
            switch (request.arguments.action) {
                case "claim":
                    return {
                        structuredContent: {
                            claimed: true,
                            delivery: {
                                modelContext: snapshot().modelContext,
                                message: "Continue",
                            },
                        },
                    };
                case "validate":
                    return { structuredContent: { valid: true } };
                case "attempt":
                    attempts += 1;
                    return {
                        structuredContent:
                            attempts === 1
                                ? { attempted: true }
                                : { attempted: false, duplicate: true },
                    };
                case "report":
                    reports += 1;
                    return { structuredContent: { reported: true } };
                case "release":
                    releases += 1;
                    return { structuredContent: { released: true } };
                default:
                    return { structuredContent: snapshot() };
            }
        },
    };
    const session = new McpAppSession();
    session.configure("ctx-one", { token: "capability" });
    const connection = new McpAppConnection(session, app);
    const firstHost = {
        updateModelContext: async () => undefined,
        sendMessage: async () => {
            signalFirstSend();
            await new Promise<void>((resolve) => {
                releaseSend = resolve;
            });
            return { isError: false };
        },
    } as unknown as McpAppHost;
    const secondHost = {
        updateModelContext: async () => undefined,
        sendMessage: async () => {
            throw new Error("duplicate directive must not be sent twice");
        },
    } as unknown as McpAppHost;
    const directive = {
        kind: "reentry",
        intent: "automatic",
        id: "shared-action",
    } as const;
    const refresh = async () => snapshot();
    const first = new McpAppReentry(connection, firstHost).deliver(
        directive,
        refresh,
    );
    await firstSendStarted;
    await new McpAppReentry(connection, secondHost).deliver(
        directive,
        refresh,
    );
    assert.equal(releases, 0);
    assert.equal(reports, 0);
    assert.equal(attempts, 2);
    releaseSend();
    await first;
    assert.equal(reports, 1);
    assert.equal(releases, 0);
    assert.equal(
        requests.filter((request) => request.arguments.action === "claim")
            .length,
        2,
    );
    assert.ok(
        requests
            .filter((request) => request.arguments.action === "attempt")
            .every(
                (request) => request.arguments.directiveId === "shared-action",
            ),
    );
});

test("presentation renders public items and actions in primary, work, background order", () => {
    const current = snapshot();
    current.presentation.work.push({
        kind: "work",
        id: "work-1",
        title: "Build <site>",
        state: "running",
        progress: { current: 1, total: 3 },
        detail: "Working detail",
        current: "Current work",
        note: "Waiting for user decision",
        actions: [{ id: "pause", label: "Pause" }],
    });
    current.presentation.background.push({
        kind: "background",
        id: "background-1",
        title: "Long process",
        badge: "Waiting",
        actions: [],
    });
    const html = renderMcpApp(current, new Set(), "inline");
    assert.ok(html.indexOf("Review") < html.indexOf("Build &lt;site&gt;"));
    assert.ok(
        html.indexOf("Build &lt;site&gt;") < html.indexOf("Long process"),
    );
    assert.match(html, /data-item="decision-1" data-action="approve"/u);
    assert.match(html, /1 \/ 3/u);
    assert.match(html, /<div>Working detail<\/div><div>Current work<\/div><div>Waiting for user decision<\/div>/u);
});

test("card binding requires inline Confirm, Cancel makes no RPC, and busy confirmation remains disabled", () => {
    const root = new CardRoot();
    const requests: McpAppActionRequest[] = [];
    const view = new McpAppView(root as unknown as HTMLElement, {
        action: (request) => requests.push(request),
        displayMode: () => undefined,
    });
    const current = snapshot();
    current.presentation.primary!.actions[0]!.confirmation = {
        message: "Proceed <carefully>?",
    };
    view.setSnapshot(current);
    const action = cardButton({ item: "decision-1", action: "approve" }, [
        "[data-action]",
    ]);
    const confirm = cardButton(
        {},
        ["[data-confirm-action], [data-cancel-confirmation]"],
        ["data-confirm-action"],
    );
    const cancel = cardButton(
        {},
        ["[data-confirm-action], [data-cancel-confirmation]"],
        ["data-cancel-confirmation"],
    );
    root.emit("click", action);
    assert.deepEqual(requests, []);
    assert.match(root.innerHTML, /Proceed &lt;carefully&gt;\?/u);
    assert.match(root.innerHTML, /data-confirm-action>Confirm<\/button>/u);
    assert.match(root.innerHTML, /data-cancel-confirmation>Cancel<\/button>/u);
    root.emit("click", cancel);
    root.emit("click", confirm);
    assert.deepEqual(requests, []);
    root.emit("click", action);
    view.setBusy("approve", true);
    assert.match(root.innerHTML, /data-confirm-action disabled/u);
    root.emit("click", confirm);
    assert.deepEqual(requests, []);
    view.setBusy("approve", false);
    root.emit("click", confirm);
    root.emit("click", confirm);
    assert.deepEqual(requests, [{ itemId: "decision-1", actionId: "approve" }]);
    assert.doesNotMatch(root.innerHTML, /data-confirm-action/u);
    view.destroy();
});

test("decision actions send a selected choice and a separate text response", () => {
    const root = new CardRoot();
    const requests: McpAppActionRequest[] = [];
    const view = new McpAppView(root as unknown as HTMLElement, {
        action: request => requests.push(request),
        displayMode: () => undefined,
    });
    const current = snapshot();
    current.presentation.primary = {
        kind: "decision", id: "decision-1", title: "Decision",
        actions: [
            { id: "choose", label: "Choose", input: { kind: "choice", choices: [{ id: "continue", label: "Continue" }, { id: "stop", label: "Stop" }] } },
            { id: "answer", label: "Send", input: { kind: "text" } },
        ],
    };
    view.setSnapshot(current);
    assert.match(root.innerHTML, /data-value="continue"/u);
    assert.match(root.innerHTML, />Continue<\/button>/u);
    assert.match(root.innerHTML, />Send<\/button>/u);
    const choice = cardButton({ item: "decision-1", action: "choose", value: "continue" }, ["[data-action]"]);
    root.emit("click", choice);
    assert.deepEqual(requests, [{ itemId: "decision-1", actionId: "choose", input: "continue" }]);
    view.setBusy("choose", true);
    root.emit("click", choice);
    assert.equal(requests.length, 1);
    root.emit("submit", {
        dataset: { actionItem: "decision-1", actionId: "answer" },
        matches: (selector: string) => selector === "[data-action-item]",
        querySelector: (selector: string) => selector === 'input[name="input"]' ? { value: "typed answer" } : { disabled: false },
    });
    assert.deepEqual(requests, [
        { itemId: "decision-1", actionId: "choose", input: "continue" },
        { itemId: "decision-1", actionId: "answer", input: "typed answer" },
    ]);
    view.destroy();
});

test("watch updates preserve partially typed input and confirmation, but disappearing actions and Context replacements clear them", () => {
    const root = new CardRoot();
    const requests: McpAppActionRequest[] = [];
    const view = new McpAppView(root as unknown as HTMLElement, {
        action: (request) => requests.push(request),
        displayMode: () => undefined,
    });
    const current = snapshot();
    current.presentation.primary!.actions[0]!.input = { kind: "text" };
    current.presentation.primary!.actions[0]!.confirmation = {
        message: "Send this input?",
    };
    view.setSnapshot(current);
    const form = {
        dataset: { actionItem: "decision-1", actionId: "approve" },
        matches: (selector: string) => selector === "[data-action-item]",
        querySelector: (selector: string) =>
            selector === "button"
                ? { disabled: false }
                : { value: "  unfinished <answer>  " },
    };
    const input = {
        value: "  unfinished <answer>  ",
        matches: (selector: string) => selector === 'input[name="input"]',
        closest: () => form,
    };
    root.emit("input", input);
    view.setSnapshot({ ...current, cursor: current.cursor + 1 });
    assert.match(root.innerHTML, /value=" {2}unfinished &lt;answer&gt; {2}"/u);
    root.emit("submit", form);
    assert.deepEqual(requests, []);
    view.setSnapshot({ ...current, cursor: current.cursor + 2 });
    assert.match(root.innerHTML, /data-confirm-action/u);
    assert.match(root.innerHTML, /value=" {2}unfinished &lt;answer&gt; {2}"/u);
    view.setSnapshot({
        ...current,
        presentation: {
            primary: { ...current.presentation.primary!, actions: [] },
            work: [],
            background: [],
        },
    });
    view.setSnapshot(current);
    assert.doesNotMatch(root.innerHTML, /data-confirm-action/u);
    assert.match(root.innerHTML, /value=""/u);
    root.emit("input", input);
    root.emit("submit", form);
    const removed = { ...current, presentation: { work: [], background: [] } };
    view.setSnapshot(removed);
    view.setSnapshot(current);
    assert.doesNotMatch(root.innerHTML, /data-confirm-action/u);
    assert.match(root.innerHTML, /value=""/u);
    root.emit("input", input);
    root.emit("submit", form);
    view.setSnapshot({ ...current, ctxId: "ctx-new" });
    assert.doesNotMatch(root.innerHTML, /data-confirm-action/u);
    assert.match(root.innerHTML, /value=""/u);
    root.emit(
        "click",
        cardButton(
            {},
            ["[data-confirm-action], [data-cancel-confirmation]"],
            ["data-confirm-action"],
        ),
    );
    assert.deepEqual(requests, []);
    view.destroy();
});

test("remount waits for Host settlement after lease expiry and reclaims inline only once", async t => {
    t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
    const context: McpAppHostContext = { availableDisplayModes: ["inline", "pip"], displayMode: "pip" };
    let widgetState: McpAppWidgetState = { privateContent: { portableDevshellPresentation: { mode: "pip", expiresAt: 1_050 } } };
    const requests: McpAppDisplayMode[] = [];
    const presentation = new McpAppPresentation({
        get hostContext() { return context; },
        readWidgetState: () => widgetState,
        writeWidgetState: state => { widgetState = state; },
        requestDisplayMode: async mode => { requests.push(mode); context.displayMode = mode; return mode; },
    });
    presentation.connected();
    assert.equal(presentation.transitionSettling, true);
    assert.deepEqual(requests, []);
    assert.equal(widgetState.privateContent!.portableDevshellPresentation, undefined);
    t.mock.timers.tick(100);
    assert.equal(presentation.transitionSettling, false);
    context.displayMode = "inline";
    presentation.onHostContextChanged(context);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(requests, ["pip"]);
    context.displayMode = "inline";
    presentation.onHostContextChanged(context);
    assert.deepEqual(requests, ["pip"]);
    presentation.disconnect();
});

test("presentation claims PiP once and consumes the transition lease after remount", async () => {
    const context: McpAppHostContext = {
        availableDisplayModes: ["inline", "pip", "fullscreen"],
        displayMode: "inline",
    };
    let widgetState: McpAppWidgetState = {
        modelContent: null,
        privateContent: {},
        imageIds: [],
    };
    let requests = 0;
    let finishRequest!: (mode: McpAppDisplayMode) => void;
    const host = {
        get hostContext() {
            return context;
        },
        readWidgetState: () => widgetState,
        writeWidgetState: (state: McpAppWidgetState) => {
            widgetState = state;
        },
        requestDisplayMode: async (mode: McpAppDisplayMode) => {
            requests += 1;
            context.displayMode = mode;
            return await new Promise<McpAppDisplayMode>(resolve => { finishRequest = resolve; });
        },
    };
    const first = new McpAppPresentation(host);
    first.connected();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(requests, 1);
    assert.equal(
        (
            widgetState.privateContent?.portableDevshellPresentation as {
                mode: string;
            }
        ).mode,
        "pip",
    );

    const remounted = new McpAppPresentation(host);
    remounted.connected();
    assert.equal(requests, 1);
    assert.equal(remounted.transitionSettling, true);
    assert.equal(
        widgetState.privateContent?.portableDevshellPresentation,
        undefined,
    );
    finishRequest("pip");
    await Promise.resolve();
    await Promise.resolve();
    remounted.disconnect();
    first.disconnect();
});

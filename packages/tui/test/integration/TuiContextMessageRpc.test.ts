import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

import {
    asInstanceName,
    PrefixRoute,
    type JsonValue,
    type PrefixRouteSnapshot,
    type ToolCallRecord,
} from "@portable-devshell/shared";

import { ContextMessageService } from "../../../control/src/instance/context/ContextMessageService.ts";
import { ControlSocketServer } from "../../../control/src/server/socket/ControlSocketServer.ts";
import { createTuiClients } from "../../src/runtime/client/TuiClientComposition.ts";
import { TuiRuntime } from "../../src/runtime/TuiRuntime.js";
import {
    currentTuiRoute,
    readContextConversationDraft,
} from "../../src/testing.ts";
import { renderExpandableBoxLines } from "../../src/view/component/TuiComponentExpandableBox.js";
import { selectMainScreenModel } from "../../src/view/model/TuiViewProjection.js";

test("real Ink and control socket edit and deliver Comments only to the matching ctxId", async (t) => {
    const harness = await createHarness([
        {
            callId: "call-seed-alpha",
            ctxId: "ctx-alpha",
            input: { command: "pwd" },
            inputSummary: '{"command":"pwd"}',
            instance: "alpha" as never,
            output: { exitCode: 0, stderr: "", stdout: "/workspace\n" },
            source: "mcp",
            startedAt: "2026-08-03T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        },
    ]);
    t.after(async () => await harness.close());

    await harness.messages.queue({ ctxId: "ctx-beta", text: "beta seed comment" });
    await delay(5);
    await harness.messages.queue({
        ctxId: "ctx-alpha",
        text: "alpha seed comment",
    });
    await harness.start();
    await enterAuditContext(harness, "ctx-alpha");

    harness.terminal.write("m");
    await waitUntil(() => currentTuiRoute(harness.runtime.store.getState()).view === "conversation");
    await waitUntil(() => harness.runtime.store.getState().ui.mainFocusId === "conversation-composer");
    const conversation = conversationText(harness.runtime);
    assert.match(conversation, /alpha seed comment/u);
    assert.equal(conversation.includes("beta seed comment"), false);

    harness.terminal.write("\u001b[A");
    await waitUntil(
        () =>
            harness.runtime.store.getState().ui.mainFocusId ===
            "conversation-pending",
    );
    harness.terminal.write(" ");
    await waitUntil(
        () =>
            box(harness.runtime, "conversation-pending")?.expanded === true,
    );
    harness.terminal.write(" ");
    await waitUntil(
        () =>
            box(harness.runtime, "conversation-pending")?.expanded === false,
    );
    harness.terminal.write("\u001b[B");
    await waitUntil(
        () =>
            harness.runtime.store.getState().ui.mainFocusId ===
            "conversation-composer",
    );

    harness.terminal.write(" ");
    await waitUntil(
        () => box(harness.runtime, "conversation-composer")?.expanded === true,
    );
    const browseDraft = renderExpandableBoxLines(
        box(harness.runtime, "conversation-composer")!,
        80,
    ).find((line) => line.segments?.some((segment) => segment.text.includes("<empty>")));
    assert.equal(
        browseDraft?.segments?.some(
            (segment) => segment.text.includes("<empty>") && segment.underline === true,
        ),
        true,
        "only the Comment value must be underlined in browse mode",
    );
    harness.terminal.write("\u001b[B");
    await waitUntil(
        () =>
            box(harness.runtime, "conversation-composer")
                ?.selectedDetailLineId === "conversation-composer:draft",
    );

    harness.terminal.write("\r");
    await waitUntil(() => harness.runtime.store.getState().interaction.focusScope === "contextConversation");
    harness.terminal.write("abcd");
    await waitUntil(() => draft(harness.runtime, "ctx-alpha") === "abcd");
    harness.terminal.write("\u007f");
    await waitUntil(() => draft(harness.runtime, "ctx-alpha") === "abc");
    harness.terminal.write("\u001b[3~");
    await waitUntil(() => draft(harness.runtime, "ctx-alpha") === "ab");

    harness.terminal.write("c\r");
    await waitUntil(async () =>
        (await harness.messages.list("ctx-alpha")).some((message) => message.text === "abc"),
    );
    assert.equal(
        (await harness.messages.list("ctx-alpha")).find(
            (message) => message.text === "abc",
        )?.status,
        "sent",
    );
    assert.equal(draft(harness.runtime, "ctx-alpha"), "");
    assert.equal(
        (await harness.messages.list("ctx-beta")).some((message) => message.text === "abc"),
        false,
    );

    harness.terminal.write("linefeed\n");
    await waitUntil(async () =>
        (await harness.messages.list("ctx-alpha")).some((message) => message.text === "linefeed"),
    );
    assert.equal(harness.routeCalls.contextQueue >= 2, true, "Comment sends must cross the real control RPC route");

});

test("real Ink keeps Space, Enter, route hierarchy, logical focus and rendered highlight consistent", async (t) => {
    const toolCall: ToolCallRecord = {
        callId: "call-1",
        ctxId: "ctx-alpha",
        input: { command: "pwd" },
        inputSummary: '{"command":"pwd"}',
        instance: "alpha" as never,
        source: "mcp",
        startedAt: "2026-08-03T00:00:00.000Z",
        status: "completed",
        toolName: "bash_run",
    };
    const secondToolCall: ToolCallRecord = {
        ...toolCall,
        callId: "call-2",
        input: { path: "./README.md" },
        inputSummary: '{"path":"./README.md"}',
        startedAt: "2026-08-03T00:00:01.000Z",
        toolName: "file_read",
    };
    const harness = await createHarness([toolCall, secondToolCall]);
    t.after(async () => await harness.close());
    await harness.messages.queue({ ctxId: "ctx-alpha", text: "focus message" });
    await harness.start();

    await selectAudit(harness);
    await focusBox(harness, "audit-context:ctx-alpha");
    const contextBox = () => box(harness.runtime, "audit-context:ctx-alpha");

    harness.terminal.write(" ");
    await waitUntil(() => contextBox()?.expanded === true);
    assert.equal(currentTuiRoute(harness.runtime.store.getState()).view, "contexts");
    harness.terminal.write(" ");
    await waitUntil(() => contextBox()?.expanded === false);

    harness.terminal.write("\r");
    await waitUntil(() => currentTuiRoute(harness.runtime.store.getState()).view === "context");
    const callBox = () => box(harness.runtime, "audit-call:call-1");
    await focusBox(harness, "audit-call:call-1");
    await waitUntil(() => callBox()?.focused === true);
    await delay(50);
    assert.equal(callBox()?.enterable, false);
    assert.equal(callBox()?.primaryAction, undefined);
    assert.equal(callBox()?.expandable, true);
    assert.equal(callBox()?.expanded, false);
    assert.equal(currentTuiRoute(harness.runtime.store.getState()).view, "context");

    await harness.runtime.handleInput("", { return: true });
    await waitUntil(() => callBox()?.expanded === true);
    assert.equal(currentTuiRoute(harness.runtime.store.getState()).view, "context");
    await delay(100);
    const callRender = renderExpandableBoxLines(callBox()!, 80);
    assert.equal(callRender[0]?.backgroundColor, "magenta");
    assert.equal(callRender.some((line) => line.backgroundColor === "cyan"), true);
    assert.equal(callBox()?.focused, true);
    assert.equal(harness.runtime.store.getState().ui.mainFocusId, callBox()?.id);

    const firstDetailLine = callBox()?.selectedDetailLineId;
    harness.terminal.write("\u001b[B");
    await waitUntil(
        () =>
            callBox()?.selectedDetailLineId !== undefined &&
            callBox()?.selectedDetailLineId !== firstDetailLine,
    );
    const rememberedDetailLine = callBox()?.selectedDetailLineId;

    harness.terminal.write(" ");
    await waitUntil(() => callBox()?.expanded === false);
    harness.terminal.write(" ");
    await waitUntil(() => callBox()?.expanded === true);
    assert.equal(
        callBox()?.selectedDetailLineId,
        rememberedDetailLine,
        "Space collapse and re-expand must preserve the selected detail line",
    );
    harness.terminal.write(" ");
    await waitUntil(() => callBox()?.expanded === false);
    harness.terminal.write("\u001b[B");
    await waitUntil(() => harness.runtime.store.getState().ui.mainFocusId !== "audit-call:call-1");
    const nextFocused = selectMainScreenModel(harness.runtime.store.getState()).boxes.find((candidate) => candidate.focused);
    assert.notEqual(nextFocused, undefined);
    assert.equal(renderExpandableBoxLines(nextFocused!, 80)[0]?.backgroundColor, "magenta");
    assert.equal(harness.runtime.focusManager.currentFocus()?.id, nextFocused?.id);

    await harness.runtime.handleInput("", { escape: true });
    await waitUntil(() => currentTuiRoute(harness.runtime.store.getState()).view === "contexts");
    await waitUntil(() => contextBox()?.focused === true);
    assert.equal(renderExpandableBoxLines(contextBox()!, 80)[0]?.backgroundColor, "magenta");
    assert.equal(harness.runtime.store.getState().ui.mainFocusId, "audit-context:ctx-alpha");
});

interface Harness {
    close(): Promise<void>;
    messages: ContextMessageService;
    routeCalls: { contextQueue: number };
    runtime: TuiRuntime;
    start(): Promise<void>;
    terminal: ReturnType<typeof createTerminal>;
}

async function createHarness(toolCalls: readonly ToolCallRecord[] = []): Promise<Harness> {
    const root = await createTestTempDirectory("tui-context-rpc");
    const socketPath = process.platform === "win32"
        ? `\\\\.\\pipe\\portable-devshell-tui-${process.pid}-${Date.now()}`
        : join(root, "control.sock");
    const messages = new ContextMessageService({
        appendEvent: async () => undefined,
        filePath: join(root, "context-messages.json"),
        instanceName: "alpha",
    });
    const routeCalls = { contextQueue: 0 };
    const server = new ControlSocketServer({
        routes: {
            connectionClosed() {},
            snapshot: () => createRoutes(messages, toolCalls, routeCalls),
        },
        socketPath,
    });
    await server.start();
    const clients = createTuiClients({ socketPath });
    const terminal = createTerminal();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients, inkDebug: true },
    );
    let running: Promise<void> | undefined;

    return {
        messages,
        routeCalls,
        runtime,
        terminal,
        async start() {
            running = runtime.run();
            await waitUntil(() => runtime.store.getState().connection.status === "connected");
            await waitUntil(() => terminal.rawModes.includes(true)).catch((error) => {
                throw new Error(`${error instanceof Error ? error.message : String(error)}\n${terminal.output}`);
            });
        },
        async close() {
            await runtime.stop().catch(() => undefined);
            if (running !== undefined) await Promise.race([running, delay(1_000)]).catch(() => undefined);
            clients.close();
            await server.stop().catch(() => undefined);
            await rm(root, { force: true, recursive: true });
        },
    };
}

function createRoutes(
    messages: ContextMessageService,
    toolCalls: readonly ToolCallRecord[],
    routeCalls: { contextQueue: number },
): PrefixRouteSnapshot {
    const snapshot = {
        connectionState: "connected",
        daemonState: "running",
        lastSeq: 1,
        name: "alpha",
        ready: true,
        status: "ready",
    };
    return PrefixRoute.snapshot([
        {
            destination: "@control",
            modules: [
                {
                    name: "service",
                    operations: [{ name: "ping", handle: () => ({ pong: true }) }],
                },
                {
                    name: "config",
                    operations: [{
                        name: "get",
                        handle: () => ({
                            instances: [{
                                enabled: true,
                                mcp: {
                                    enabled: true,
                                    tools: {
                                        capabilities: ["read", "write", "execute"],
                                        groups: ["context"],
                                    },
                                },
                                name: "alpha",
                                provider: "local",
                                workspace: "/workspace/alpha",
                            }],
                            mcp: { enabled: true, listenHost: "127.0.0.1", listenPort: 3210 },
                        }),
                    }],
                },
                {
                    name: "instance",
                    operations: [{
                        name: "list",
                        handle: () => [{
                            defaultWorkspace: "/workspace/alpha",
                            enabled: true,
                            mcpEnabled: true,
                            name: "alpha",
                            provider: "local",
                        }],
                    }],
                },
                {
                    name: "mcp",
                    operations: [{ name: "status", handle: () => ({ running: false }) }],
                },
                {
                    name: "overview",
                    operations: [{ name: "get", handle: () => overview() }],
                },
                {
                    name: "artifact",
                    operations: [
                        { name: "listShares", handle: () => [] },
                        { name: "listTransfers", handle: () => [] },
                    ],
                },
            ],
        },
        {
            destination: asInstanceName("alpha"),
            modules: [
                {
                    name: "runtime",
                    operations: [
                        { name: "snapshot", handle: () => ({ lastSeq: 1, snapshot }) },
                        { name: "readLogs", handle: () => [] },
                        {
                            name: "subscribe",
                            handle: async (_request, context) => {
                                await context.openStream({ events: [], lastSeq: 1 });
                                return undefined;
                            },
                        },
                    ],
                },
                {
                    name: "tool",
                    operations: [
                        { name: "listCalls", handle: () => [...toolCalls] as unknown as JsonValue },
                        { name: "listApprovals", handle: () => [] },
                    ],
                },
                {
                    name: "contextMessage",
                    operations: [
                        {
                            name: "list",
                            handle: async (request) => {
                                const payload = (request.payload ?? {}) as { ctxId?: string };
                                return await messages.list(payload.ctxId) as unknown as JsonValue;
                            },
                        },
                        {
                            name: "queue",
                            handle: async (request) => {
                                const payload = request.payload as { ctxId: string; text: string };
                                routeCalls.contextQueue += 1;
                                return await messages.queue(payload) as unknown as JsonValue;
                            },
                        },
                    ],
                },
                {
                    name: "todo",
                    operations: [{
                        name: "get",
                        handle: () => ({
                            lastSeq: 1,
                            todo: {
                                items: [],
                                revision: 0,
                                summary: { completed: 0, total: 0 },
                                taskId: "task-1",
                                title: "Todo",
                            },
                        }),
                    }],
                },
            ],
        },
    ]);
}

function overview(): JsonValue {
    return {
        activity: [],
        alerts: [],
        controller: { pid: process.pid, uptimeSeconds: 1 },
        counts: {
            activeTodos: 0,
            failedCalls24h: 0,
            instancesAttention: 0,
            instancesCritical: 0,
            instancesReady: 1,
            instancesTotal: 1,
            pendingApprovals: 0,
        },
        generatedAt: "2026-08-03T00:00:00.000Z",
        health: "healthy",
        instances: [],
        todos: [],
    };
}

async function selectAudit(harness: Harness): Promise<void> {
    harness.terminal.write("4");
    await waitUntil(() => harness.runtime.store.getState().ui.selectedPage === "audit");
    harness.terminal.write("!");
    await waitUntil(() => harness.runtime.store.getState().ui.selectedInstance === "alpha");
    await waitUntil(() => box(harness.runtime, "audit-context:ctx-alpha") !== undefined);
    for (let attempt = 0; attempt < 5; attempt += 1) {
        harness.terminal.write("\t");
        await delay(25);
        if (harness.runtime.store.getState().interaction.focusScope === "mainBoxes") return;
    }
    throw new Error(
        `Tab did not enter the main panel: scope=${harness.runtime.store.getState().interaction.focusScope} focus=${JSON.stringify(harness.runtime.focusManager.currentFocus())}`,
    );
}

async function enterAuditContext(harness: Harness, ctxId: string): Promise<void> {
    await selectAudit(harness);
    await focusBox(harness, `audit-context:${ctxId}`);
    harness.terminal.write("\r");
    await waitUntil(() => currentTuiRoute(harness.runtime.store.getState()).view === "context");
}

async function focusBox(harness: Harness, id: string): Promise<void> {
    for (let index = 0; index < 20; index += 1) {
        if (harness.runtime.store.getState().ui.mainFocusId === id) return;
        harness.terminal.write("\u001b[B");
        await delay(10);
    }
    throw new Error(`Unable to focus ${id}; current focus is ${harness.runtime.store.getState().ui.mainFocusId ?? "none"}`);
}

function box(runtime: TuiRuntime, id: string) {
    return selectMainScreenModel(runtime.store.getState()).boxes.find((candidate) => candidate.id === id);
}

function draft(runtime: TuiRuntime, ctxId: string): string {
    return readContextConversationDraft(runtime.store.getState(), "alpha", ctxId);
}

function conversationText(runtime: TuiRuntime): string {
    return selectMainScreenModel(runtime.store.getState()).boxes
        .flatMap((candidate) => [
            candidate.title,
            ...candidate.collapsedLines.map((line) => line.text),
            ...candidate.expandedLines.map((line) => line.text),
        ])
        .join("\n");
}

function createTerminal(): {
    output: string;
    rawModes: boolean[];
    stdin: ReadStream;
    stdout: WriteStream;
    write(value: string): void;
} {
    class Input extends PassThrough {
        readonly isTTY = true;
        readonly rawModes: boolean[] = [];
        ref(): this { return this; }
        setRawMode(enabled: boolean): this { this.rawModes.push(enabled); return this; }
        unref(): this { return this; }
    }
    class Output extends PassThrough {
        readonly columns = 120;
        readonly isTTY = true;
        readonly rows = 40;
    }
    const input = new Input();
    const output = new Output();
    let captured = "";
    output.on("data", (chunk) => { captured += chunk.toString(); });
    return {
        get output() { return captured; },
        rawModes: input.rawModes,
        stdin: input as unknown as ReadStream,
        stdout: output as unknown as WriteStream,
        write(value: string) { input.write(value); },
    };
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await predicate()) return;
        await delay(10);
    }
    throw new Error("Timed out waiting for TUI state.");
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

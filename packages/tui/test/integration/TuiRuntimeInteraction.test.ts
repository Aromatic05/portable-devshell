import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import { asInstanceName, type ApprovalRequest, type ToolCallRecord } from "@portable-devshell/shared";

import type { TuiClients } from "../../src/runtime/client/TuiClientComposition.ts";
import { TuiRuntime } from "../../src/runtime/TuiRuntime.ts";
import {
    currentTuiRoute,
    topTuiOverlay,
    TuiTerminalSession,
    type TuiTerminalPty,
} from "../../src/testing.ts";
import {
    buildTuiHitRegions,
    buildTuiTerminalViewportRegion,
    hitTargetAt,
    tuiScreenSelectionColumnBounds,
} from "../../src/view/TuiHitRegions.ts";
import {
    selectMainScreenModel,
    selectMainScrollKey,
} from "../../src/view/model/TuiViewProjection.ts";
import { createTestTempDirectory } from "../../../../test/TestTempDirectory.ts";

test("real Ink runtime handles keyboard navigation, search, redraw, and terminal cleanup", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        assert.equal(runtime.store.getState().ui.selectedPage, "overview");
        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        await waitUntil(() => terminal.output.includes("Create Instance"));

        await waitUntil(() => terminal.rawModes.includes(true));
        assert.match(terminal.output, /instances 0 \| live 0/u);
        assert.match(terminal.output, /Create Instance/u);

        terminal.write("8");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );
        await waitUntil(() => terminal.output.includes("Navigation"));

        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        terminal.write("/");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "search",
        );
        await writeCharacters(terminal, "alpha");
        await waitUntil(
            () =>
                runtime.store.getState().ui.searchQueries.instances === "alpha",
        );
        await waitUntil(() => terminal.output.includes("/ alpha"));

        terminal.write("\u0008");
        await waitUntil(
            () =>
                runtime.store.getState().ui.searchQueries.instances === "alph",
        );
        terminal.write("\u001b");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope !== "search",
        );

        const beforeRedraw = terminal.output.length;
        terminal.write("\u000c");
        await waitUntil(() =>
            terminal.output.slice(beforeRedraw).includes("\u001B[2J\u001B[H"),
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }

    assert.equal(clients.closed(), 1);
    assert.equal(terminal.rawModes.at(-1), false);
    assert.equal(terminal.output.includes("\u001B[?1049h"), true);
    assert.equal(terminal.output.includes("\u001B[?1049l"), true);
});

test("real Ink runtime strips bracketed paste markers from app input", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        terminal.write("/");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "search",
        );

        terminal.write("\u001B[200~pasted\u001B[201~");
        await waitUntil(
            () =>
                runtime.store.getState().ui.searchQueries.instances === "pasted",
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime preserves every key in a burst of escape sequences", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        runtime.store.setSidebarCursor({ id: "overview", kind: "context" });
        runtime.store.setFocusScope("sidebarContext");

        terminal.write("\u001B[B\u001B[B");
        await waitUntil(
            () => runtime.store.getState().interaction.sidebarCursor?.id === "config",
            250,
        );
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("real Ink runtime preserves every shortcut in a printable input burst", async () => {
    const terminal = createTerminal();
    const clients = createClients({
        instanceList: [
            { enabled: true, mcpEnabled: true, name: "alpha" },
            { enabled: true, mcpEnabled: true, name: "beta" },
        ],
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        terminal.write("4@");
        await waitUntil(
            () =>
                runtime.store.getState().ui.selectedPage === "messages" &&
                runtime.store.getState().ui.selectedInstance === "beta",
            250,
        );
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("serializes rapid Audit Input navigation and activation", async () => {
    const terminal = createTerminal();
    const clients = createClients({
        instanceList: [{ enabled: true, mcpEnabled: true, name: "alpha" }],
        toolCallRecords: [{
            callId: "rapid-input",
            ctxId: "ctx-rapid",
            input: { command: "printf rapid-input" },
            inputSummary: '{"command":"printf rapid-input"}',
            instance: asInstanceName("alpha"),
            output: { stdout: "rapid-output" },
            source: "mcp",
            startedAt: "2026-08-09T00:00:00.000Z",
            status: "completed",
            toolName: "bash_run",
        }],
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        runtime.store.setSelectedInstance("alpha");
        runtime.store.setSelectedPage("audit");
        runtime.store.replaceRoute({
            ctxId: "ctx-rapid",
            page: "audit",
            scope: "context",
            view: "context",
        });
        await runtime.session.refreshAudit("alpha");
        await waitUntil(() => runtime.store.getState().readModel.instanceState.alpha?.toolCalls.length === 1);
        await waitUntil(() => selectMainScreenModel(runtime.store.getState()).boxes.some(
            (candidate) => candidate.id === "audit-call:rapid-input",
        ));
        const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (candidate) => candidate.id === "audit-call:rapid-input",
        )!;
        runtime.store.toggleExpanded(box.expandedKey);
        runtime.store.setFocusScope("mainBoxes");
        runtime.store.setMainFocusId(box.id);
        const expandedBox = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (candidate) => candidate.id === box.id,
        )!;
        const inputLineIndex = expandedBox.expandedLines.findIndex((line) =>
            line.id?.endsWith(":input") === true,
        );
        assert.notEqual(inputLineIndex, -1);

        await Promise.all([
            ...Array.from({ length: inputLineIndex }, () =>
                runtime.handleInput("", { downArrow: true }),
            ),
            runtime.handleInput("", { return: true }),
        ]);

        const overlay = topTuiOverlay(runtime.store.getState().interaction.overlays);
        assert.equal(overlay?.kind, "text-detail");
        assert.equal(overlay?.kind === "text-detail" && overlay.body.includes("rapid-input"), true);
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("real Ink runtime saves a restart-required Config edit through cross-box keyboard focus", async () => {
    const terminal = createTerminal();
    const clients = createClients({
        configView: {
            control: { logLevel: "info" },
            instances: [{
                enabled: true,
                logs: {
                    eventBufferSize: 500,
                    maxBytes: 16_777_216,
                    retentionDays: 7,
                },
                mcp: { enabled: true, path: "/alpha/mcp" },
                name: "alpha",
                provider: "local",
                security: {
                    effectiveMode: "workspace",
                    mode: "workspace",
                },
            }],
            mcp: { enabled: false, listenHost: "127.0.0.1", listenPort: 0 },
            restartControlRequired: false,
        },
        instanceList: [{
            homeDirectory: "/workspace/alpha",
            enabled: true,
            mcpEnabled: true,
            name: "alpha",
            provider: "local",
        }],
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        await waitUntil(
            () => runtime.store.getState().ui.selectedInstance === "alpha",
        );
        await waitUntil(
            () => runtime.store.getState().readModel.instanceState.alpha?.snapshot?.ready === true,
        );
        runtime.store.setSelectedPage("config");
        await waitUntil(() =>
            selectMainScreenModel(runtime.store.getState()).boxes.some(
                (box) => box.id === "logs",
            ),
        );
        const logs = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "logs",
        );
        assert.ok(logs);
        if (!logs.expanded) runtime.store.toggleExpanded(logs.expandedKey);
        runtime.store.setMainFocusId(logs.id);
        runtime.store.setFocusScope("boxDetail");
        runtime.store.setSelectedDetailLine(
            logs.expandedKey,
            "logs:field:logs.retentionDays",
        );

        terminal.write("\r");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "form",
        );
        terminal.write("\r");
        await waitUntil(
            () => runtime.store.getState().interaction.editor?.editing === true,
        );
        terminal.write("\u0008");
        await waitUntil(() => {
            const draft = runtime.store.getState().ui.formDrafts["config:alpha"] as {
                logs?: { retentionDays?: unknown };
            } | undefined;
            return draft?.logs?.retentionDays === "";
        });
        terminal.write("7");
        await waitUntil(
            () => runtime.store.getState().ui.dirtyForms["config:alpha"] === false,
        );
        const unchangedActions = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "configuration-actions",
        );
        assert.equal(unchangedActions?.expanded, true);

        terminal.write("\u0008");
        await waitUntil(() => {
            const draft = runtime.store.getState().ui.formDrafts["config:alpha"] as {
                logs?: { retentionDays?: unknown };
            } | undefined;
            return draft?.logs?.retentionDays === "";
        });
        terminal.write("8");
        await waitUntil(() => {
            const draft = runtime.store.getState().ui.formDrafts["config:alpha"] as {
                logs?: { retentionDays?: unknown };
            } | undefined;
            return draft?.logs?.retentionDays === "8";
        });

        for (let index = 0; index < 5; index += 1) {
            await runtime.handleInput("", { tab: true });
        }
        await waitUntil(
            () => runtime.store.getState().ui.mainFocusId === "configuration-actions",
        );
        const actions = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "configuration-actions",
        );
        assert.ok(actions);
        assert.equal(
            runtime.store.getState().interaction.selectedDetailLineIds[
                actions.expandedKey
            ],
            "configuration-actions:button:save-restart",
        );

        terminal.write("\r");
        await waitUntil(() => clients.configUpdates().length === 1);
        await waitUntil(
            () => clients.lifecycleActions().join(",") === "stop:alpha,start:alpha",
        );
        await waitUntil(
            () => runtime.store.getState().ui.dirtyForms["config:alpha"] === false,
        );
        assert.deepEqual(clients.lifecycleActions(), ["stop:alpha", "start:alpha"]);
        assert.equal(
            JSON.stringify(clients.configUpdates()[0]).includes("effectiveMode"),
            false,
        );
        assert.equal(
            JSON.stringify(clients.configUpdates()[0]).includes("restartControlRequired"),
            false,
        );

        terminal.write("\u0004");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope !== "form",
        );
        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime buffers split mouse input and enters then discards the create wizard", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );

        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        terminal.write("\t");
        await waitUntil(
            () =>
                runtime.store.getState().interaction.focusScope === "mainBoxes",
        );
        terminal.write(" ");
        await waitUntil(
            () =>
                runtime.store.getState().ui.expandedBoxes[
                    "instances:undefined:create-instance"
                ] === true,
        );

        const createRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find((region) => {
            return (
                region.target.kind === "boxBody" &&
                region.target.lineId?.endsWith(":button:create") === true
            );
        });
        assert.ok(createRegion);

        const outputBeforeCreate = terminal.output.length;
        const mouse = `\u001B[<0;${createRegion.x};${createRegion.y}M`;
        terminal.write(mouse.slice(0, 5));
        await yieldEventLoop();
        assert.equal(runtime.store.getState().interaction.editor, undefined);
        terminal.write(mouse.slice(5));
        terminal.write(mouseSequence(0, createRegion.x, createRegion.y, "release"));

        await waitUntil(
            () =>
                runtime.store.getState().interaction.editor?.kind === "create",
        );
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "wizard",
        );
        await waitUntil(() => terminal.output.length > outputBeforeCreate);

        terminal.write("\r");
        await waitUntil(
            () => runtime.store.getState().interaction.editor?.editing === true,
        );
        await writeCharacters(terminal, "demo-instance");
        await waitUntil(() => {
            const draft = runtime.store.getState().ui.formDrafts.create;
            return (
                (draft as { name?: unknown } | undefined)?.name ===
                "demo-instance"
            );
        });

        terminal.write("\u0004");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "confirm",
        );
        const discardOverlay = topTuiOverlay(
            runtime.store.getState().interaction.overlays,
        );
        assert.equal(discardOverlay?.kind, "confirmation");
        assert.equal(
            discardOverlay?.kind === "confirmation"
                ? discardOverlay.selectedAction
                : undefined,
            "cancel",
        );

        terminal.write("\u001B[C");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "confirmation" &&
                overlay.selectedAction === "confirm"
            );
        });
        terminal.write("\r");
        await waitUntil(
            () => runtime.store.getState().interaction.editor === undefined,
        );
        assert.equal(runtime.store.getState().ui.formDrafts.create, undefined);

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }

    assert.equal(clients.createSchemaCalls(), 1);
    assert.equal(clients.closed(), 1);
    assert.equal(terminal.rawModes.at(-1), false);
});

test("real Ink runtime renders connection failure and remains interactive until quit", async () => {
    const terminal = createTerminal();
    const clients = createClients({
        pingError: Object.assign(new Error("control server is not running."), {
            code: "control.notRunning",
        }),
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "disconnected",
        );
        await waitUntil(() =>
            terminal.output.includes("control server is not running."),
        );

        terminal.write("8");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );
        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }

    assert.equal(clients.closed(), 1);
    assert.equal(terminal.rawModes.at(-1), false);
});

test("real Ink runtime handles sidebar mouse buttons and viewport wheel scrolling", async () => {
    const terminal = createTerminal({ rows: 14 });
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );

        runtime.store.setSidebarCursor({ id: "help", kind: "context" });
        runtime.store.setFocusScope("sidebarContext");
        const helpRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (region) =>
                region.target.kind === "context" && region.target.id === "help",
        );
        assert.ok(helpRegion);

        terminal.write(mouseSequence(64, helpRegion.x, helpRegion.y, "press"));
        await waitUntil(() =>
            runtime.store.getState().interaction.sidebarCursor?.id === "audit",
        );
        assert.equal(runtime.store.getState().ui.selectedPage, "overview");
        runtime.store.setSidebarCursor({ id: "help", kind: "context" });
        const refreshedHelpRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (region) =>
                region.target.kind === "context" && region.target.id === "help",
        );
        assert.ok(refreshedHelpRegion);

        terminal.write(mouseSequence(0, refreshedHelpRegion.x, refreshedHelpRegion.y, "release"));
        terminal.write(mouseSequence(1, refreshedHelpRegion.x, refreshedHelpRegion.y, "press"));
        await yieldEventLoop();
        assert.equal(runtime.store.getState().ui.selectedPage, "overview");

        terminal.write(mouseSequence(0, refreshedHelpRegion.x, refreshedHelpRegion.y, "press"));
        terminal.write(mouseSequence(0, refreshedHelpRegion.x, refreshedHelpRegion.y, "release"));
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );

        const navigationBox = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "help-navigation",
        );
        assert.ok(navigationBox);
        runtime.store.toggleExpanded(navigationBox.expandedKey);
        const helpRegions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const contentRegion = helpRegions.find(
            (region) => region.target.kind === "boxBody",
        );
        assert.ok(contentRegion);
        const scrollKey = selectMainScrollKey(runtime.store.getState());
        runtime.store.setScrollOffset(scrollKey, 0);
        terminal.write(mouseSequence(65, contentRegion.x, contentRegion.y, "press"));
        await waitUntil(
            () => runtime.store.getState().ui.scrollOffsets[scrollKey] === 3,
        );

        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime activates confirmation and approval overlay actions with mouse", async () => {
    const terminal = createTerminal();
    const toolCall: ToolCallRecord = {
        callId: "call-overlay",
        input: { command: "pwd" },
        inputSummary: '{"command":"pwd"}',
        instance: asInstanceName("alpha"),
        source: "tui",
        startedAt: "2026-07-17T00:00:00.000Z",
        status: "running",
        toolName: "bash_run",
    };
    const approval: ApprovalRequest = {
        approvalId: "approval-overlay",
        callId: toolCall.callId,
        createdAt: "2026-07-17T00:00:00.000Z",
        expiresAt: "2099-07-17T00:10:00.000Z",
        inputSummary: toolCall.inputSummary,
        instance: asInstanceName("alpha"),
        reason: "needs review",
        riskLevel: "high",
        source: "tui",
        status: "pending",
        toolName: toolCall.toolName,
        workspace: "/workspace/alpha",
    };
    const clients = createClients({
        approvalRecords: [approval],
        instanceList: [
            {
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "local",
            },
        ],
        toolCallRecords: [toolCall],
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        await runtime.commandDispatcher.dispatch({
            body: "Move to Help?",
            confirmIntent: { page: "help", type: "page.select" },
            confirmLabel: "Move",
            title: "Confirm navigation",
            type: "overlay.openConfirm",
        });
        let regions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const confirm = regions.find(
            (region) =>
                region.target.kind === "overlayAction" &&
                region.target.overlay === "confirmation" &&
                region.target.action === "confirm",
        );
        assert.ok(confirm);
        terminal.write(mouseSequence(0, confirm.x, confirm.y, "press"));
        terminal.write(mouseSequence(0, confirm.x, confirm.y, "release"));
        await waitUntil(() => runtime.store.getState().ui.selectedPage === "help");
        assert.equal(topTuiOverlay(runtime.store.getState().interaction.overlays), undefined);

        runtime.store.setSelectedInstance("alpha");
        runtime.store.setSelectedPage("audit");
        await runtime.session.refreshAudit("alpha");
        await runtime.commandDispatcher.dispatch({
            approvalId: approval.approvalId,
            instance: "alpha",
            type: "approval.open",
        });
        regions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const approve = regions.find(
            (region) =>
                region.target.kind === "overlayAction" &&
                region.target.overlay === "approval" &&
                region.target.action === "approve",
        );
        assert.ok(approve);
        terminal.write(mouseSequence(0, approve.x, approve.y, "press"));
        terminal.write(mouseSequence(0, approve.x, approve.y, "release"));
        await waitUntil(() => {
            const overlay = topTuiOverlay(runtime.store.getState().interaction.overlays);
            return overlay?.kind === "confirmation" && overlay.title === "Confirm Approval";
        });
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("production Ink scrolling does not clear and repaint the whole terminal", async () => {
    const terminal = createTerminal({ columns: 120, rows: 14 });
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        runtime.store.setSelectedPage("help");
        const navigationBox = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "help-navigation",
        );
        assert.ok(navigationBox);
        runtime.store.toggleExpanded(navigationBox.expandedKey);
        await waitUntil(() => terminal.output.includes("Navigation"));
        await new Promise((resolve) => setTimeout(resolve, 40));

        const clearsBefore = countOccurrences(terminal.output, "\u001B[2J");
        const key = selectMainScrollKey(runtime.store.getState());
        runtime.store.setScrollOffset(key, 0);
        await runtime.commandDispatcher.dispatch({ delta: 3, type: "screen.scroll" });
        await waitUntil(() => (runtime.store.getState().ui.scrollOffsets[key] ?? 0) > 0);
        await new Promise((resolve) => setTimeout(resolve, 40));

        assert.equal(countOccurrences(terminal.output, "\u001B[2J"), clearsBefore);
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("host terminal resize immediately reflows the live TUI", async () => {
    const terminal = createTerminal({ columns: 120, rows: 40 });
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        const beforeResize = terminal.output.length;
        terminal.resize(59, 20);
        await waitUntil(
            () => terminal.output.slice(beforeResize).includes("Terminal too small"),
            250,
        );
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("real Ink runtime moves mouse focus into an expanded main box from the sidebar", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        terminal.write("8");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );

        const navigation = selectMainScreenModel(
            runtime.store.getState(),
        ).boxes.find((box) => box.id === "help-navigation");
        assert.ok(navigation);
        runtime.store.toggleExpanded(navigation.expandedKey);
        runtime.store.setSidebarCursor({ id: "config", kind: "context" });
        runtime.store.setFocusScope("sidebarContext");

        const region = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (candidate) =>
                candidate.target.kind === "boxBody" &&
                candidate.target.boxId === "help-navigation" &&
                candidate.target.lineId !== undefined,
        );
        assert.ok(region);

        terminal.write(mouseSequence(0, region.x, region.y, "press"));
        terminal.write(mouseSequence(0, region.x, region.y, "release"));

        await waitUntil(
            () =>
                runtime.store.getState().interaction.focusScope ===
                "mainBoxes",
        );
        await waitUntil(
            () => runtime.store.getState().ui.mainFocusId === "help-navigation",
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime drag-selects ordinary TUI text and copies it without activating the row", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        let helpRow: number | undefined;
        for (let row = 1; row <= runtime.rows; row += 1) {
            await runtime.selection.beginSelection(1, row);
            runtime.selection.updateSelection(runtime.columns, row);
            if (runtime.selection.getSelectionText().includes("help")) {
                helpRow = row;
                break;
            }
        }
        runtime.selection.clearSelection();
        assert.notEqual(helpRow, undefined);
        runtime.selection.clearSelection();

        const helpRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (region) =>
                region.target.kind === "context" && region.target.id === "help",
        );
        assert.ok(helpRegion);
        assert.equal(helpRegion.y, helpRow);

        const viewport = { columns: runtime.columns, rows: runtime.rows };
        const sidebarBounds = tuiScreenSelectionColumnBounds(
            runtime.store.getState(),
            viewport,
            helpRegion.x,
            helpRow!,
        );
        const mainBounds = tuiScreenSelectionColumnBounds(
            runtime.store.getState(),
            viewport,
            runtime.columns,
            helpRow!,
        );
        assert.ok(sidebarBounds);
        assert.ok(mainBounds);
        assert.ok(sidebarBounds.end <= mainBounds.start);
        assert.ok(sidebarBounds.start <= helpRegion.x - 1);
        assert.ok(helpRegion.x - 1 < sidebarBounds.end);
        assert.equal(
            tuiScreenSelectionColumnBounds(
                runtime.store.getState(),
                viewport,
                1,
                1,
            ),
            undefined,
        );

        await runtime.selection.beginSelection(helpRegion.x, helpRow!);
        runtime.selection.updateSelection(
            helpRegion.x + helpRegion.width - 1,
            helpRow!,
        );
        assert.match(runtime.selection.getSelectionText(), /help/u);
        runtime.selection.clearSelection();

        const outputStart = terminal.output.length;
        terminal.write(mouseSequence(0, 1, helpRow!, "press"));
        terminal.write(mouseSequence(32, runtime.columns, helpRow!, "press"));
        terminal.write(mouseSequence(0, runtime.columns, helpRow!, "release"));

        await waitUntil(() =>
            terminal.output.slice(outputStart).includes("\u001B]52;c;"),
        );
        const clipboard = terminal.output
            .slice(outputStart)
            .split("\u001B]52;c;", 2)[1]
            ?.split("\u0007", 1)[0];
        assert.ok(clipboard);
        assert.match(Buffer.from(clipboard, "base64").toString("utf8"), /help/u);
        assert.equal(runtime.store.getState().ui.selectedPage, "overview");
        assert.ok(runtime.selection.getSnapshot().characters > 0);

        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        assert.equal(runtime.selection.getSnapshot().characters, 0);

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("screen selection updates only the selection layer, not the TUI root", async () => {
    const terminal = createTerminal();
    const clients = createClients();
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const originalGetSnapshot = runtime.scheduler.getSnapshot.bind(runtime.scheduler);
    let rootSnapshotReads = 0;
    Object.defineProperty(runtime.scheduler, "getSnapshot", {
        configurable: true,
        value: () => {
            rootSnapshotReads += 1;
            return originalGetSnapshot();
        },
    });
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        await yieldEventLoop();
        rootSnapshotReads = 0;

        await runtime.selection.beginSelection(2, 2);
        runtime.selection.updateSelection(5, 2);
        await yieldEventLoop();

        assert.equal(rootSnapshotReads, 0);
    } finally {
        terminal.write("\u0004");
        await running;
        await runtime.stop();
    }
});

test("real Ink runtime renders compact and unsupported terminal layouts", async () => {
    for (const terminalOptions of [
        { columns: 80, expected: "1:inst", rows: 20 },
        { columns: 59, expected: "Terminal too small (need 60x14)", rows: 13 },
    ]) {
        const terminal = createTerminal(terminalOptions);
        const clients = createClients({
            instanceList: [
                {
                    enabled: true,
                    mcpEnabled: true,
                    name: "alpha",
                    provider: "local",
                },
            ],
        });
        const runtime = new TuiRuntime(
            { stdin: terminal.stdin, stdout: terminal.stdout },
            { clients: clients.value, inkDebug: true },
        );
        const running = runtime.run();

        try {
            await waitUntil(
                () =>
                    runtime.store.getState().connection.status === "connected",
            );
            await waitUntil(() =>
                terminal.output.includes(terminalOptions.expected),
            );
            assert.equal(runtime.columns, terminalOptions.columns);
            assert.equal(runtime.rows, terminalOptions.rows);
            if (terminalOptions.columns === 80) {
                const beforeTerminal = terminal.output.length;
                terminal.write("9");
                await waitUntil(
                    () => runtime.store.getState().ui.selectedPage === "terminal",
                );
                await waitUntil(() =>
                    terminal.output
                        .slice(beforeTerminal)
                        .includes("▶9:terminal"),
                );
                assert.match(
                    terminal.output.slice(beforeTerminal),
                    /S\d+:/u,
                );
            }
            terminal.write("\u0004");
            await running;
        } finally {
            await runtime.stop();
        }
    }
});

test("real Ink runtime routes every page and drives approval and text detail screens", async () => {
    const terminal = createTerminal();
    const toolCall: ToolCallRecord = {
        callId: "call-1",
        input: { command: "pwd" },
        inputSummary: '{"command":"pwd"}',
        instance: asInstanceName("alpha"),
        source: "tui",
        startedAt: "2026-07-17T00:00:00.000Z",
        status: "running",
        toolName: "bash_run",
    };
    const approval: ApprovalRequest = {
        approvalId: "approval-1",
        callId: "call-1",
        createdAt: "2026-07-17T00:00:00.000Z",
        expiresAt: "2099-07-17T00:10:00.000Z",
        inputSummary: '{"command":"pwd"}',
        instance: asInstanceName("alpha"),
        reason: "needs review",
        riskLevel: "high",
        source: "tui",
        status: "pending",
        toolName: "bash_run",
    };
    const clients = createClients({
        approvalRecords: [approval],
        instanceList: [{
            homeDirectory: "/workspace/alpha",
            enabled: true,
            mcpEnabled: true,
            name: "alpha",
            provider: "local",
        }],
        toolCallRecords: [toolCall],
    });
    const runtime = new TuiRuntime(
        { stdin: terminal.stdin, stdout: terminal.stdout },
        { clients: clients.value, inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        runtime.store.setSelectedPage("overview");
        const pages = [
            "instances",
            "config",
            "connections",
            "messages",
            "audit",
            "logs",
            "todo",
            "help",
            "terminal",
        ] as const;
        for (let index = 0; index < pages.length; index += 1) {
            terminal.write(String(index + 1));
            await waitUntil(
                () => runtime.store.getState().ui.selectedPage === pages[index],
            );
        }

        runtime.store.setSelectedInstance("alpha");
        runtime.store.setSelectedPage("audit");
        runtime.store.pushOverlay({
            approvalId: "approval-1",
            instance: "alpha",
            kind: "approval",
            selectedAction: "back",
        });
        runtime.store.setFocusScope("approvalDetail");

        await waitUntil(() => terminal.output.includes("Approval"));
        terminal.write("\u001B[B");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "approval" &&
                overlay.selectedAction === "input"
            );
        });
        terminal.write("\r");
        await waitUntil(
            () =>
                topTuiOverlay(runtime.store.getState().interaction.overlays)
                    ?.kind === "text-detail",
        );
        await waitUntil(() =>
            terminal.output.includes("bash_run · approval input"),
        );
        terminal.write("\r");
        await waitUntil(
            () =>
                topTuiOverlay(runtime.store.getState().interaction.overlays)
                    ?.kind === "approval",
        );

        runtime.store.pushOverlay({
            body: Array.from(
                { length: 80 },
                (_, index) => `line-${index}`,
            ).join("\n"),
            kind: "text-detail",
            scrollOffset: 0,
            title: "Long Detail",
        });
        runtime.store.setFocusScope("textDetail");
        assert.equal(
            topTuiOverlay(runtime.store.getState().interaction.overlays)?.kind,
            "text-detail",
        );
        terminal.write("\u001B[6~");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "text-detail" && overlay.scrollOffset === 10
            );
        });
        terminal.write("\u001B[5~");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "text-detail" && overlay.scrollOffset === 0
            );
        });
        terminal.write("\u001B[B");
        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "text-detail" && overlay.scrollOffset === 1
            );
        });
        terminal.write("\r");
        await waitUntil(
            () =>
                topTuiOverlay(runtime.store.getState().interaction.overlays)
                    ?.kind === "approval",
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime routes Open Terminal without suspending the TUI", async () => {
    const host = createTerminal();
    const clients = createClients();
    let detached = 0;
    const embedded = new TuiTerminalSession({
        ptyFactory: () => ({
            kill() { detached += 1; },
            onData() { return { dispose() {} }; },
            onExit() { return { dispose() {} }; },
            resize() {},
            write() {},
        }),
    });
    const runtime = new TuiRuntime(
        { stdin: host.stdin, stdout: host.stdout },
        { clients: clients.value, inkDebug: true, terminal: embedded },
    );
    const running = runtime.run();

    try {
        await waitUntil(() => runtime.store.getState().connection.status === "connected");
        clients.setControlState(
            [{
                homeDirectory: process.cwd(),
                enabled: true,
                mcpEnabled: false,
                name: "alpha",
                provider: "local",
            }],
            {
                instances: [{
                    enabled: true,
                    name: "alpha",
                    provider: "local",
                }],
            },
        );
        runtime.store.patchControlReadModel({ instances: [{
            homeDirectory: process.cwd(),
            enabled: true,
            mcpEnabled: false,
            name: "alpha",
            provider: "local",
        }] });
        runtime.store.patchControlSnapshot({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 1,
            name: asInstanceName("alpha"),
            ready: true,
            status: "ready",
        });
        runtime.store.setSelectedPage("instances");

        await waitUntil(() =>
            selectMainScreenModel(runtime.store.getState()).boxes.some(
                (box) => box.id === "instance:alpha",
            ),
        );
        let instanceBox = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "instance:alpha",
        );
        assert.ok(instanceBox?.expandedKey);
        runtime.store.toggleExpanded(instanceBox.expandedKey);
        instanceBox = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (box) => box.id === "instance:alpha",
        );
        const attachLine = instanceBox?.expandedLines.find(
            (line) => line.id?.endsWith(":button:open-terminal") === true,
        );
        assert.ok(instanceBox?.expandedKey);
        assert.ok(attachLine?.id);
        runtime.store.setMainFocusId(instanceBox.id);
        runtime.store.setSelectedDetailLine(instanceBox.expandedKey, attachLine.id);
        runtime.store.setFocusScope("boxDetail");

        const enters = countOccurrences(host.output, "\u001B[?1049h");
        const exits = countOccurrences(host.output, "\u001B[?1049l");
        await runtime.commandDispatcher.dispatch({ type: "focus.activate" });
        await waitUntil(() => runtime.store.getState().ui.selectedPage === "terminal");
        await waitUntil(() => embedded.getSnapshot().status === "running");

        assert.equal(runtime.store.getState().interaction.focusScope, "terminal");
        assert.equal(countOccurrences(host.output, "\u001B[?1049h"), enters);
        assert.equal(countOccurrences(host.output, "\u001B[?1049l"), exits);
        assert.equal(detached, 0);

        await runtime.stop();
        await running;
    } finally {
        await runtime.stop();
    }

    assert.equal(detached, 1);
});

test("real Ink runtime routes terminal scrollback and mouse without trapping sidebar clicks", async () => {
    const host = createTerminal();
    const clients = createClients();
    let dataListener: ((data: string) => void) | undefined;
    const writes: string[] = [];
    const pty: TuiTerminalPty = {
        kill() {},
        onData(listener) {
            dataListener = listener;
            return { dispose() {} };
        },
        onExit() {
            return { dispose() {} };
        },
        resize() {},
        write(data) {
            writes.push(data);
        },
    };
    const embedded = new TuiTerminalSession({ ptyFactory: () => pty });
    const runtime = new TuiRuntime(
        { stdin: host.stdin, stdout: host.stdout },
        {
            clients: clients.value,
            graphicsMode: "kitty",
            inkDebug: true,
            terminal: embedded,
        },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        clients.setControlState(
            [
                {
                    homeDirectory: process.cwd(),
                    enabled: true,
                    mcpEnabled: true,
                    name: "alpha",
                    provider: "ssh",
                },
            ],
            {
                instances: [
                    {
                        name: "alpha",
                        provider: "ssh",
                        ssh: { command: "ssh example.test" },
                    },
                ],
            },
        );
        runtime.store.patchControlReadModel({ instances: [
            {
                homeDirectory: process.cwd(),
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "ssh",
            },
        ] });
        runtime.store.patchControlReadModel({ configView: {
            instances: [
                {
                    name: "alpha",
                    provider: "ssh",
                    ssh: { command: "ssh example.test" },
                },
            ],
        } as never });
        runtime.store.setSelectedInstance("alpha");
        runtime.store.setSelectedPage("instances");

        host.write("9");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "terminal",
        );
        await waitUntil(() => embedded.getSnapshot().status === "running");
        host.write("\t");
        await waitUntil(
            () =>
                runtime.store.getState().interaction.focusScope === "terminal",
        );
        await waitUntil(() => host.output.includes("\u001B[?1h\u001B="));

        host.write("\u001B[A");
        await waitUntil(() => writes.includes("\u001B[A"));

        const terminalRegion = buildTuiTerminalViewportRegion(
            runtime.store.getState(),
            {
                columns: runtime.columns,
                rows: runtime.rows,
            },
        );
        assert.ok(terminalRegion);
        dataListener?.("select me");
        await waitUntil(
            () =>
                embedded
                    .getSnapshot()
                    .lines[0]?.segments.some((segment) =>
                        segment.text.includes("select"),
                    ) === true,
        );
        host.write(
            mouseSequence(0, terminalRegion.x, terminalRegion.y, "press"),
        );
        host.write(
            mouseSequence(32, terminalRegion.x + 5, terminalRegion.y, "press"),
        );
        host.write(
            mouseSequence(0, terminalRegion.x + 5, terminalRegion.y, "release"),
        );
        await waitUntil(() =>
            host.output.includes("\u001B]52;c;c2VsZWN0\u0007"),
        );

        dataListener?.("\u001B[?2004h");
        await waitUntil(
            () => embedded.getSnapshot().modes.bracketedPaste === true,
        );
        host.write("\u001B[200~pasted");
        host.write(" text\u001B[201~");
        await waitUntil(() =>
            writes.includes("\u001B[200~pasted text\u001B[201~"),
        );

        dataListener?.("\u001B_Ga=T,f=100;AAAA\u001B\\");
        await waitUntil(() => embedded.getSnapshot().graphics.count === 1);
        await waitUntil(() =>
            host.output.includes("\u001B_Ga=T,f=100;AAAA\u001B\\"),
        );
        assert.equal(host.output.includes("\u001B_Ga=d,d=A;\u001B\\"), true);

        const clearsAfterGraphic = countOccurrences(
            host.output,
            "\u001B_Ga=d,d=A;\u001B\\",
        );
        dataListener?.("plain update");
        await waitUntil(() =>
            embedded.getSnapshot().lines.some((line) =>
                line.segments.some((segment) => segment.text.includes("plain update")),
            ),
        );
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
            countOccurrences(host.output, "\u001B_Ga=d,d=A;\u001B\\"),
            clearsAfterGraphic,
        );

        dataListener?.(
            Array.from({ length: 80 }, (_, index) => String(index)).join(
                "\r\n",
            ),
        );
        await waitUntil(() => embedded.getSnapshot().scroll.historyLines > 0);
        host.write("\u001B[5;");
        await yieldEventLoop();
        assert.equal(embedded.getSnapshot().scroll.atBottom, true);
        host.write("2~");
        await waitUntil(
            () => embedded.getSnapshot().scroll.atBottom === false,
        );

        dataListener?.("\u001B[?1000;1006h");
        await waitUntil(
            () => embedded.getSnapshot().modes.mouseTracking === "vt200",
        );
        host.write(
            mouseSequence(
                0,
                terminalRegion.x + 4,
                terminalRegion.y + 2,
                "press",
            ),
        );
        await waitUntil(() => writes.includes("\u001B[<0;5;3M"));

        const helpRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (region) =>
                region.target.kind === "context" && region.target.id === "help",
        );
        assert.ok(helpRegion);
        const beforePageChange = host.output.length;
        host.write(mouseSequence(0, helpRegion.x, helpRegion.y, "press"));
        host.write(mouseSequence(0, helpRegion.x, helpRegion.y, "release"));
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );
        await waitUntil(() =>
            host.output
                .slice(beforePageChange)
                .includes("\u001B_Ga=d,d=A;\u001B\\"),
        );

        host.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }

    assert.equal(clients.closed(), 1);
    assert.equal(host.rawModes.at(-1), false);
});

test("real Ink runtime switches terminal sources and drives tmux View and Attach", async () => {
    const host = createTerminal();
    const ptyWrites: string[] = [];
    const embedded = new TuiTerminalSession({
        ptyFactory: () => ({
            kill() {},
            onData() {
                return { dispose() {} };
            },
            onExit() {
                return { dispose() {} };
            },
            resize() {},
            write(data) {
                ptyWrites.push(data);
            },
        }),
    });
    const clients = createClients({
        configView: {
            instances: [
                {
                    enabled: true,
                    extensions: { model: ["instance"] },
                    mcp: { enabled: true },
                    name: "alpha",
                    provider: "ssh",
                    security: { mode: "disabled" },
                    ssh: { command: "ssh example.invalid" },
                },
            ],
        },
        instanceList: [
            {
                homeDirectory: process.cwd(),
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "ssh",
            },
        ],
        toolCallRecords: [{
            callId: "call-existing-tmux",
            inputSummary: "{}",
            instance: "alpha",
            source: "mcp",
            startedAt: "2026-08-30T00:00:00.000Z",
            status: "completed",
            toolName: "tmux_list",
            workspace: process.cwd(),
        } as ToolCallRecord],
        toolCall(_instance, toolName, input) {
            if (toolName === "tmux_list") {
                return {
                    panes: [
                        {
                            id: "%1",
                            name: "agent",
                            status: "running",
                            task: { id: "task-agent", status: "running" },
                        },
                    ],
                };
            }
            if (toolName === "tmux_inspect") {
                return {
                    panes: [
                        {
                            command: "read first; read second",
                            cwd: process.cwd(),
                            id: "%1",
                            lines: ["ready"],
                            name: "agent",
                            status: "running",
                            task: { id: "task-agent", status: "running" },
                        },
                    ],
                };
            }
            if (toolName === "tmux_input") {
                assert.deepEqual(input, {
                    input: "echo hello^M",
                    task: "task-agent",
                    timeMs: 0,
                });
                return {
                    output: ["echo hello", "hello"],
                    task: { id: "task-agent", status: "running" },
                };
            }
            throw new Error(`Unexpected tool ${toolName}`);
        },
    });
    const runtime = new TuiRuntime(
        { stdin: host.stdin, stdout: host.stdout },
        { clients: clients.value, inkDebug: true, terminal: embedded },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        await waitUntil(() => runtime.store.getState().instances.length === 1);
        runtime.store.setSelectedInstance("alpha");

        host.write("9");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "terminal",
        );
        host.write("\tx");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "terminal",
        );
        await waitUntil(() => ptyWrites.includes("x"), 250);
        assert.equal(currentTuiRoute(runtime.store.getState()).page, "terminal");

        host.write("\u0014");
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "terminal" && route.tab === "tmuxPanes";
        });
        await waitUntil(() => runtime.tmuxPanes.getSnapshot().panes.length === 1);
        assert.equal(buildTuiTerminalViewportRegion(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }), undefined);

        const fullScreenRegions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const tabTargets = fullScreenRegions.filter(
            (region) => region.target.kind === "terminalTab",
        );
        assert.equal(tabTargets.length, 2);
        assert.equal(
            fullScreenRegions.some(
                (region) =>
                    region.target.kind === "context" ||
                    region.target.kind === "instance",
            ),
            true,
            "tmux output must retain the main side panel for switching and exit",
        );

        const instancesTabRegion = tabTargets.find(
            (region) =>
                region.target.kind === "terminalTab" &&
                region.target.tab === "instances",
        )!;
        host.write(mouseSequence(0, instancesTabRegion.x, instancesTabRegion.y, "press"));
        host.write(mouseSequence(0, instancesTabRegion.x, instancesTabRegion.y, "release"));
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "terminal" && route.tab === "instances";
        });
        assert.ok(buildTuiTerminalViewportRegion(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }));

        const instancesLayoutRegions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const tmuxTabRegion = instancesLayoutRegions.find(
            (region) =>
                region.target.kind === "terminalTab" &&
                region.target.tab === "tmuxPanes",
        )!;
        host.write(mouseSequence(0, tmuxTabRegion.x, tmuxTabRegion.y, "press"));
        host.write(mouseSequence(0, tmuxTabRegion.x, tmuxTabRegion.y, "release"));
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "terminal" && route.tab === "tmuxPanes";
        });
        await waitUntil(() => runtime.tmuxPanes.getSnapshot().panes.length === 1);

        host.write("\r");
        await waitUntil(
            () => runtime.tmuxPanes.getSnapshot().active?.attached === true,
        );
        host.write("echo hello\r");
        await waitUntil(() =>
            clients.toolCalls().some((call) => call.toolName === "tmux_input"),
        );
        await waitUntil(() => host.output.includes("hello"));

        host.write("\u001B");
        await waitUntil(
            () => runtime.tmuxPanes.getSnapshot().active?.attached === false,
        );
        host.write("\u0014");
        await waitUntil(() => {
            const route = currentTuiRoute(runtime.store.getState());
            return route.page === "terminal" && route.tab === "instances";
        });
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "terminal",
        );
        await waitUntil(() => embedded.getSnapshot().status === "running");
        assert.ok(buildTuiTerminalViewportRegion(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }));

        host.write("\t");
        await waitUntil(() => ptyWrites.includes("\t"));
        assert.equal(
            clients.toolCalls().filter((call) => call.toolName === "tmux_input").length,
            1,
        );

        host.write("\u001D");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope !== "terminal",
        );
        host.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime renders artifact_viewImage audit output in the detail panel", async () => {
    const host = createTerminal();
    const imageCall: ToolCallRecord = {
        callId: "image-call",
        ctxId: "ctx-image",
        completedAt: "2026-07-18T00:00:01.000Z",
        input: { path: "./preview.png" },
        inputSummary: '{"path":"./preview.png"}',
        instance: asInstanceName("alpha"),
        output: {
            bytes: 68,
            mediaType: "image/png",
            name: "preview.png",
            source: {
                instance: "alpha",
                path: "./preview.png",
                type: "file",
            },
        },
        source: "mcp",
        startedAt: "2026-07-18T00:00:00.000Z",
        status: "completed",
        toolName: "artifact_viewImage",
    };
    const clients = createClients({
        configView: {
            instances: [{
                enabled: true,
                extensions: { model: ["instance"] },
                mcp: { auth: "none", contextMode: "explicit", enabled: true, path: "/alpha/mcp" },
                name: "alpha",
                provider: "local",
                security: { mode: "disabled" },
            }],
        },
        image: {
            bytes: 68,
            content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            encoding: "base64",
            mediaType: "image/png",
            name: "preview.png",
            source: { instance: "alpha", path: "./preview.png", type: "file" },
        },
        instanceList: [{
            enabled: true,
            homeDirectory: "/home/alpha",
            mcpEnabled: true,
            name: "alpha",
            provider: "local",
        }],
        toolCallRecords: [imageCall],
    });
    const runtime = new TuiRuntime(
        { stdin: host.stdin, stdout: host.stdout },
        { clients: clients.value, graphicsMode: "kitty", inkDebug: true },
    );
    const running = runtime.run();

    try {
        await waitUntil(
            () => runtime.store.getState().connection.status === "connected",
        );
        runtime.store.setSelectedInstance("alpha");
        runtime.store.setSelectedPage("audit");
        await waitUntil(() =>
            runtime.store.getState().readModel.instanceState.alpha?.toolCalls.some(
                (call) => call.callId === "image-call",
            ) === true,
        );
        runtime.store.replaceRoute({
            ctxId: "ctx-image",
            page: "audit",
            scope: "context",
            view: "context",
        });
        assert.equal(runtime.store.getState().ui.selectedInstance, "alpha");
        assert.deepEqual(currentTuiRoute(runtime.store.getState()), {
            ctxId: "ctx-image",
            page: "audit",
            scope: "context",
            view: "context",
        });
        assert.deepEqual(
            runtime.store.getState().readModel.instanceState.alpha?.toolCalls.map((call) => call.callId),
            ["image-call"],
        );

        const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (candidate) => candidate.id === "audit-call:image-call",
        );
        assert.ok(box);
        runtime.store.toggleExpanded(box.expandedKey);
        runtime.store.setFocusScope("boxDetail");
        runtime.store.setMainFocusId(box.id);
        runtime.store.setSelectedDetailLine(
            box.expandedKey,
            "audit-call:image-call:output",
        );
        await runtime.commandDispatcher.dispatch({ type: "focus.activate" });

        await waitUntil(() => {
            const overlay = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            return (
                overlay?.kind === "text-detail" &&
                overlay.image?.name === "preview.png"
            );
        });
        await waitUntil(() => host.output.includes("a=T,f=100"));
        assert.equal(host.output.includes("c="), true);

        const beforeClose = host.output.length;
        await runtime.commandDispatcher.dispatch({ type: "textDetail.close" });
        await waitUntil(() =>
            host.output.slice(beforeClose).includes("a=d,d=A"),
        );

        host.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }

    assert.deepEqual(clients.imageReads(), [
        {
            input: {
                instance: "alpha",
                path: "./preview.png",
                workspace: "/home/alpha",
            },
            instance: "alpha",
        },
    ]);
});

function createClients(
    options: {
        configUpdate?: (request: unknown) => unknown;
        configView?: Record<string, unknown>;
        instanceList?: Array<{
            homeDirectory?: string;
            enabled: boolean;
            mcpEnabled: boolean;
            name: string;
            provider?: string;
        }>;
        image?: {
            bytes: number;
            content: string;
            encoding: "base64";
            mediaType: "image/gif" | "image/jpeg" | "image/png" | "image/webp";
            name: string;
            source: {
                handle?: string;
                instance: string;
                path?: string;
                type?: "artifact" | "directory" | "file";
            };
        };
        approvalRecords?: ApprovalRequest[];
        contextRecords?: import("@portable-devshell/shared").McpContextRecord[];
        pingError?: Error;
        toolCall?: (instance: string, toolName: string, input: unknown) => unknown;
        toolCallRecords?: ToolCallRecord[];
    } = {},
) {
    let closeCount = 0;
    let configView = options.configView ?? { instances: [] };
    let instanceList = options.instanceList ?? [];
    const configUpdates: unknown[] = [];
    const imageReads: Array<{ input: unknown; instance: string }> = [];
    const lifecycleActions: string[] = [];
    let refreshCount = 0;
    let schemaCalls = 0;
    const toolCalls: Array<{ input: unknown; instance: string; toolName: string }> = [];
    const value = {
        artifact: {
            async viewImage(instance: string, input: unknown) {
                imageReads.push({ input, instance });
                if (options.image === undefined) {
                    throw new Error("No image fixture configured.");
                }
                return options.image;
            },
            async listShares() {
                return [];
            },
            async listTransfers() {
                return [];
            },
        },
        close() {
            closeCount += 1;
        },
        onTransportClose() {
            return () => undefined;
        },
        config: {
            async get() {
                return configView;
            },
            async update(request: unknown) {
                configUpdates.push(request);
                return options.configUpdate?.(request) ?? {};
            },
            async validate(draft: unknown) {
                return draft;
            },
        },
        instance: {
            async createSchema() {
                schemaCalls += 1;
                return {
                    container: {
                        defaultMode: "preset",
                        modes: [
                            "preset",
                            "dockerfile",
                            "compose",
                            "existingImage",
                            "existingStoppedContainer",
                        ],
                        presets: [],
                    },
                    defaultEnabled: true,
                    defaultMcpEnabled: true,
                    defaultModelExtensions: ["instance"],
                    defaultProvider: "local",
                    defaultSecurityMode: "disabled",
                    providers: ["local", "ssh", "docker", "podman"],
                };
            },
            async list() {
                return instanceList.map((instance) => ({
                    ...instance,
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 2,
                        name: instance.name,
                        ready: true,
                        status: "ready",
                    },
                }));
            },
        },
        mcp: {
            async listApprovals() {
                return [];
            },
            async status() {
                return {};
            },
        },
        overview: {
            async get() {
                return {
                    activity: [],
                    alerts: [],
                    controller: { pid: 1, uptimeSeconds: 10 },
                    counts: {
                        activeTodos: 0,
                        failedCalls24h: 0,
                        instancesAttention: 0,
                        instancesCritical: 0,
                        instancesReady: 0,
                        instancesTotal: 0,
                        pendingApprovals: 0,
                    },
                    generatedAt: "2026-07-31T00:00:00.000Z",
                    health: "healthy",
                    instances: [],
                    todos: [],
                };
            },
        },
        async reconnect() {},
        reverse: {},
        runtime: {
            async readLogs() {
                return [];
            },
            async subscribe() {
                let closed = false;
                let resolveClosed: ((message: { kind: "closed" }) => void) | undefined;
                return {
                    close() {
                        closed = true;
                        resolveClosed?.({ kind: "closed" });
                    },
                    async next() {
                        if (closed) return { kind: "closed" as const };
                        return await new Promise<{ kind: "closed" }>((resolve) => {
                            resolveClosed = resolve;
                        });
                    },
                };
            },
            async snapshot(instance: string) {
                return {
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 2,
                        name: instance,
                        ready: true,
                        status: "ready",
                    },
                };
            },
            async refresh(instance: string) {
                refreshCount += 1;
                return {
                    snapshot: {
                        connectionState: "connected",
                        daemonState: "running",
                        lastSeq: 2,
                        name: instance,
                        ready: true,
                        status: "ready",
                    },
                };
            },
            async start(instance: string) {
                lifecycleActions.push(`start:${instance}`);
                return {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 4,
                    name: instance,
                    ready: true,
                    status: "ready",
                };
            },
            async stop(instance: string) {
                lifecycleActions.push(`stop:${instance}`);
                return {
                    connectionState: "disconnected",
                    daemonState: "stopped",
                    lastSeq: 3,
                    name: instance,
                    ready: false,
                    status: "stopped",
                };
            },
        },
        service: {
            async hello() {
                return {
                    capabilities: ["request", "stream", "streamResume"],
                    protocolVersion: 1,
                };
            },
            async ping() {
                if (options.pingError !== undefined) {
                    throw options.pingError;
                }
                return { pong: true };
            },
        },
        todo: {
            async get() {
                return {
                    todo: {
                        items: [],
                        revision: 0,
                        summary: { completed: 0, total: 0 },
                    },
                };
            },
        },
        tool: {
            async call(instance: string, toolName: string, input: unknown) {
                toolCalls.push({ input, instance, toolName });
                return options.toolCall?.(instance, toolName, input) ?? {};
            },
            async listApprovals() {
                return options.approvalRecords ?? [];
            },
            async listCalls() {
                return options.toolCallRecords ?? [];
            },
        },
        context: {
            async list() {
                return options.contextRecords ?? [];
            },
            async disable() {
                return { ctxId: "" } as never;
            },
            async renew() {
                return { ctxId: "" } as never;
            },
        },
    } as unknown as TuiClients;

    return {
        closed: () => closeCount,
        configUpdates: () => configUpdates,
        createSchemaCalls: () => schemaCalls,
        imageReads: () => imageReads,
        lifecycleActions: () => lifecycleActions,
        refreshCalls: () => refreshCount,
        toolCalls: () => toolCalls,
        setControlState(
            nextInstances: typeof instanceList,
            nextConfigView: Record<string, unknown>,
        ) {
            instanceList = nextInstances;
            configView = nextConfigView;
        },
        value,
    };
}

function createTerminal(options: { columns?: number; rows?: number } = {}): {
    output: string;
    rawModes: boolean[];
    resize(columns: number, rows: number): void;
    stdin: ReadStream;
    stdout: WriteStream;
    write(value: string): void;
} {
    class Input extends PassThrough {
        readonly isTTY = true;
        readonly rawModes: boolean[] = [];

        ref(): this {
            return this;
        }

        setRawMode(enabled: boolean): this {
            this.rawModes.push(enabled);
            return this;
        }

        unref(): this {
            return this;
        }
    }

    class Output extends PassThrough {
        columns = options.columns ?? 120;
        readonly isTTY = true;
        rows = options.rows ?? 40;
    }

    const input = new Input();
    const output = new Output();
    let captured = "";
    output.on("data", (chunk) => {
        captured += chunk.toString();
    });

    return {
        get output() {
            return captured;
        },
        rawModes: input.rawModes,
        resize(columns: number, rows: number) {
            output.columns = columns;
            output.rows = rows;
            output.emit("resize");
        },
        stdin: input as unknown as ReadStream,
        stdout: output as unknown as WriteStream,
        write(value: string) {
            input.write(value);
        },
    };
}

async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 10_000,
): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() >= deadline) {
            throw new Error("Timed out waiting for TUI state.");
        }
        await yieldEventLoop();
    }
}

async function yieldEventLoop(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

async function writeCharacters(
    terminal: Pick<ReturnType<typeof createTerminal>, "write">,
    value: string,
): Promise<void> {
    for (const character of value) {
        terminal.write(character);
        await yieldEventLoop();
    }
}

function mouseSequence(
    button: number,
    x: number,
    y: number,
    kind: "press" | "release",
): string {
    return `\u001B[<${button};${x};${y}${kind === "press" ? "M" : "m"}`;
}

function countOccurrences(value: string, needle: string): number {
    return value.split(needle).length - 1;
}

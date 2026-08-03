import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { ReadStream, WriteStream } from "node:tty";
import test from "node:test";

import { asInstanceName } from "@portable-devshell/shared";

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
        await waitUntil(() => terminal.output.includes("Create Instance"));

        await waitUntil(() => terminal.rawModes.includes(true));
        assert.match(terminal.output, /instances 0 \| live 0/u);
        assert.match(terminal.output, /Create Instance/u);

        terminal.write("7");
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
                workspace: "/workspace/alpha",
            }],
            mcp: { enabled: false, listenHost: "127.0.0.1", listenPort: 0 },
            restartControlRequired: false,
        },
        instanceList: [{
            defaultWorkspace: "/workspace/alpha",
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
            () => runtime.store.getState().snapshotsByInstance.alpha?.ready === true,
        );
        runtime.store.setSelectedPage("config");
        await delay(20);
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
        terminal.write("8");
        await waitUntil(() => {
            const draft = runtime.store.getState().ui.formDrafts["config:alpha"] as {
                logs?: { retentionDays?: unknown };
            } | undefined;
            return draft?.logs?.retentionDays === "8";
        });

        for (let index = 0; index < 5; index += 1) {
            terminal.write("\t");
            await delay(20);
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
        await delay(20);
        assert.equal(runtime.store.getState().interaction.editor, undefined);
        terminal.write(mouse.slice(5));

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
                ? discardOverlay.title
                : undefined,
            "Discard Unsaved Changes",
        );
        assert.equal(
            discardOverlay?.kind === "confirmation"
                ? discardOverlay.selectedAction
                : undefined,
            "cancel",
        );

        let resolved = false;
        void running.then(() => {
            resolved = true;
        });
        await delay(20);
        assert.equal(resolved, false);

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

        terminal.write("7");
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

        const helpRegion = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        }).find(
            (region) =>
                region.target.kind === "page" && region.target.id === "help",
        );
        assert.ok(helpRegion);

        terminal.write(mouseSequence(0, helpRegion.x, helpRegion.y, "release"));
        terminal.write(mouseSequence(1, helpRegion.x, helpRegion.y, "press"));
        await delay(20);
        assert.equal(runtime.store.getState().ui.selectedPage, "instances");

        terminal.write(mouseSequence(0, helpRegion.x, helpRegion.y, "press"));
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "help",
        );

        terminal.write("1");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "instances",
        );
        const regions = buildTuiHitRegions(runtime.store.getState(), {
            columns: runtime.columns,
            rows: runtime.rows,
        });
        const viewport = regions.find(
            (region) => region.target.kind === "scrollViewport",
        );
        assert.ok(viewport);
        const bareViewportY = Array.from(
            { length: viewport.height },
            (_, offset) => viewport.y + offset,
        ).find((y) => {
            return (
                hitTargetAt(regions, viewport.x, y)?.kind === "scrollViewport"
            );
        });
        assert.notEqual(bareViewportY, undefined);
        const scrollKey = selectMainScrollKey(runtime.store.getState());
        runtime.store.setScrollOffset(scrollKey, 5);
        terminal.write(mouseSequence(64, viewport.x, bareViewportY!, "press"));
        await waitUntil(
            () => runtime.store.getState().ui.scrollOffsets[scrollKey] === 0,
        );

        terminal.write("\u0004");
        await running;
    } finally {
        await runtime.stop();
    }
});

test("real Ink runtime renders compact and unsupported terminal layouts", async () => {
    for (const terminalOptions of [
        { columns: 80, expected: "1:inst", rows: 20 },
        { columns: 59, expected: "Terminal too small (need 60x14)", rows: 13 },
    ]) {
        const terminal = createTerminal(terminalOptions);
        const clients = createClients();
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
            terminal.write("\u0004");
            await running;
        } finally {
            await runtime.stop();
        }
    }
});

test("real Ink runtime routes every page and drives approval and text detail screens", async () => {
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
        const pages = [
            "instances",
            "config",
            "connections",
            "audit",
            "logs",
            "todo",
            "help",
            "terminal",
        ] as const;
        for (let index = 0; index < pages.length; index += 1) {
            terminal.write(String(index + 1));
            await delay(20);
            assert.equal(
                runtime.store.getState().ui.selectedPage,
                pages[index],
                `shortcut ${index + 1} did not select ${pages[index]}`,
            );
        }

        runtime.store.replaceInstances([
            {
                defaultWorkspace: "/workspace/alpha",
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "local",
            },
        ]);
        runtime.store.setSelectedInstance("alpha");
        runtime.store.replaceToolCalls("alpha", [
            {
                callId: "call-1",
                input: { command: "pwd" },
                inputSummary: '{"command":"pwd"}',
                instance: "alpha" as never,
                source: "tui",
                startedAt: "2026-07-17T00:00:00.000Z",
                status: "running",
                toolName: "bash_run",
            },
        ]);
        runtime.store.replaceApprovals("alpha", [
            {
                approvalId: "approval-1",
                callId: "call-1",
                createdAt: "2026-07-17T00:00:00.000Z",
                expiresAt: "2099-07-17T00:10:00.000Z",
                inputSummary: '{"command":"pwd"}',
                instance: "alpha" as never,
                reason: "needs review",
                riskLevel: "high",
                source: "tui",
                status: "pending",
                toolName: "bash_run",
            },
        ]);
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
        await delay(20);
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

test(
    "real Ink runtime suspends and remounts around an Attach Shell child process",
    { skip: process.platform === "win32" },
    async (context) => {
        const shellDirectory = await createTestTempDirectory("devshell-tui-shell");
        const shellPath = join(shellDirectory, "shell");
        await writeFile(shellPath, "#!/bin/sh\nexit 0\n", "utf8");
        await chmod(shellPath, 0o755);
        const previousShell = process.env.SHELL;
        process.env.SHELL = shellPath;
        context.after(() => {
            if (previousShell === undefined) {
                delete process.env.SHELL;
            } else {
                process.env.SHELL = previousShell;
            }
        });

        const terminal = createTerminal();
        const clients = createClients();
        const runtime = new TuiRuntime(
            { stdin: terminal.stdin, stdout: terminal.stdout },
            { clients: clients.value, inkDebug: true },
        );
        let sessionRefreshes = 0;
        (
            runtime.session as unknown as {
                refreshInstance(instance: string): Promise<void>;
            }
        ).refreshInstance = async (instance) => {
            assert.equal(instance, "alpha");
            sessionRefreshes += 1;
        };
        const running = runtime.run();

        try {
            await waitUntil(
                () =>
                    runtime.store.getState().connection.status === "connected",
            );
            clients.setControlState(
                [
                    {
                        defaultWorkspace: process.cwd(),
                        enabled: true,
                        mcpEnabled: false,
                        name: "alpha",
                        provider: "local",
                    },
                ],
                {
                    instances: [
                        {
                            enabled: true,
                            name: "alpha",
                            provider: "local",
                            workspace: process.cwd(),
                        },
                    ],
                },
            );
            runtime.store.replaceInstances([
                {
                    defaultWorkspace: process.cwd(),
                    enabled: true,
                    mcpEnabled: false,
                    name: "alpha",
                    provider: "local",
                },
            ]);
            runtime.store.replaceSnapshot({
                connectionState: "connected",
                daemonState: "running",
                lastSeq: 1,
                name: asInstanceName("alpha"),
                ready: true,
                status: "ready",
            });

            await waitUntil(() =>
                selectMainScreenModel(runtime.store.getState()).boxes.some(
                    (box) => box.id === "instance:alpha",
                ),
            );
            const titleRegion = buildTuiHitRegions(runtime.store.getState(), {
                columns: runtime.columns,
                rows: runtime.rows,
            }).find(
                (region) =>
                    region.target.kind === "boxTitle" &&
                    region.target.boxId === "instance:alpha",
            );
            assert.ok(titleRegion);
            terminal.write(
                mouseSequence(0, titleRegion.x, titleRegion.y, "press"),
            );
            await waitUntil(
                () =>
                    runtime.store.getState().ui.expandedBoxes[
                        "instances:alpha:instance"
                    ] === true,
            );

            const instanceBox = selectMainScreenModel(
                runtime.store.getState(),
            ).boxes.find((box) => box.id === "instance:alpha");
            const attachLine = instanceBox?.expandedLines.find(
                (line) => line.id?.endsWith(":button:attach-shell") === true,
            );
            assert.ok(instanceBox?.expandedKey);
            assert.ok(attachLine?.id);
            runtime.store.setScreenStatus("instances", undefined);
            runtime.store.setMainFocusId(instanceBox.id);
            runtime.store.setSelectedDetailLine(
                instanceBox.expandedKey,
                attachLine.id,
            );
            runtime.store.setFocusScope("boxDetail");
            await runtime.commandDispatcher.dispatch({
                type: "focus.activate",
            });

            await waitUntil(
                () =>
                    runtime.store.getState().interaction.focusScope ===
                    "confirm",
            );
            const shellConfirm = topTuiOverlay(
                runtime.store.getState().interaction.overlays,
            );
            assert.equal(shellConfirm?.kind, "confirmation");
            assert.equal(
                shellConfirm?.kind === "confirmation"
                    ? shellConfirm.title
                    : undefined,
                "UNMANAGED SHELL",
            );
            assert.equal(
                shellConfirm?.kind === "confirmation"
                    ? shellConfirm.selectedAction
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

            await waitUntil(() => sessionRefreshes === 1);
            assert.equal(
                runtime.store.getState().interaction.screenStatusByPage
                    .instances,
                "Shell exited. Status refreshed from control.",
            );
            assert.equal(clients.refreshCalls(), 1);
            assert.equal(
                countOccurrences(terminal.output, "\u001B[?1049h") >= 2,
                true,
            );
            assert.equal(
                countOccurrences(terminal.output, "\u001B[?1049l") >= 1,
                true,
            );

            terminal.write("\u0004");
            await running;
        } finally {
            await runtime.stop();
        }

        assert.equal(terminal.rawModes.at(-1), false);
    },
);

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
                    defaultWorkspace: process.cwd(),
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
        runtime.store.replaceInstances([
            {
                defaultWorkspace: process.cwd(),
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "ssh",
            },
        ]);
        runtime.store.setConfigView({
            instances: [
                {
                    name: "alpha",
                    provider: "ssh",
                    ssh: { command: "ssh example.test" },
                },
            ],
        } as never);
        runtime.store.setSelectedInstance("alpha");

        host.write("8");
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

        dataListener?.(
            Array.from({ length: 80 }, (_, index) => String(index)).join(
                "\r\n",
            ),
        );
        await waitUntil(() => embedded.getSnapshot().scroll.historyLines > 0);
        host.write("\u001B[5;");
        await delay(10);
        assert.equal(embedded.getSnapshot().scroll.atBottom, true);
        host.write("2~");
        await delay(50);
        assert.equal(
            embedded.getSnapshot().scroll.atBottom,
            false,
            JSON.stringify({ scroll: embedded.getSnapshot().scroll, writes }),
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
                region.target.kind === "page" && region.target.id === "help",
        );
        assert.ok(helpRegion);
        const beforePageChange = host.output.length;
        host.write(mouseSequence(0, helpRegion.x, helpRegion.y, "press"));
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
                    mcp: { enabled: true, tools: { capabilities: [], groups: [] } },
                    name: "alpha",
                    provider: "ssh",
                    security: { mode: "disabled" },
                    ssh: { command: "ssh example.invalid" },
                },
            ],
        },
        instanceList: [
            {
                defaultWorkspace: process.cwd(),
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "ssh",
            },
        ],
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

        host.write("8");
        await waitUntil(
            () => runtime.store.getState().ui.selectedPage === "terminal",
        );
        host.write("\t");
        await waitUntil(
            () => runtime.store.getState().interaction.focusScope === "terminal",
        );
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
                    region.target.kind === "page" ||
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
    const clients = createClients({
        image: {
            bytes: 68,
            content:
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
            encoding: "base64",
            mediaType: "image/png",
            name: "preview.png",
            source: { instance: "alpha", path: "./preview.png", type: "file" },
        },
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
        clients.setControlState(
            [
                {
                    enabled: true,
                    mcpEnabled: true,
                    name: "alpha",
                    provider: "local",
                },
            ],
            { instances: [{ name: "alpha", provider: "local" }] },
        );
        runtime.store.replaceInstances([
            {
                enabled: true,
                mcpEnabled: true,
                name: "alpha",
                provider: "local",
            },
        ]);
        runtime.store.setSelectedInstance("alpha");
        runtime.store.replaceToolCalls("alpha", [
            {
                callId: "image-call",
                ctxId: "ctx-image",
                completedAt: "2026-07-18T00:00:01.000Z",
                input: { path: "./preview.png" },
                inputSummary: '{"path":"./preview.png"}',
                instance: "alpha" as never,
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
            },
        ]);
        runtime.store.setSelectedPage("audit");
        runtime.store.pushRoute({
            ctxId: "ctx-image",
            page: "audit",
            scope: "context",
            view: "context",
        });

        const box = selectMainScreenModel(runtime.store.getState()).boxes.find(
            (candidate) => candidate.id === "audit-call:image-call",
        )!;
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
        { input: { path: "./preview.png" }, instance: "alpha" },
    ]);
});

function createClients(
    options: {
        configUpdate?: (request: unknown) => unknown;
        configView?: Record<string, unknown>;
        instanceList?: Array<{
            defaultWorkspace?: string;
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
        pingError?: Error;
        toolCall?: (instance: string, toolName: string, input: unknown) => unknown;
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
                    defaultMcpCapabilities: ["read", "write", "execute"],
                    defaultMcpEnabled: true,
                    defaultMcpGroups: ["file", "bash", "artifact"],
                    defaultProvider: "local",
                    defaultSecurityMode: "disabled",
                    providers: ["local", "ssh", "docker", "podman"],
                };
            },
            async list() {
                return instanceList;
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
                let resolveClosed: ((message: { kind: "connection.closed" }) => void) | undefined;
                return {
                    close() {
                        closed = true;
                        resolveClosed?.({ kind: "connection.closed" });
                    },
                    async nextMessage() {
                        if (closed) return { kind: "connection.closed" as const };
                        return await new Promise<{ kind: "connection.closed" }>((resolve) => {
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
        readonly columns = options.columns ?? 120;
        readonly isTTY = true;
        readonly rows = options.rows ?? 40;
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
        await delay(5);
    }
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function writeCharacters(
    terminal: Pick<ReturnType<typeof createTerminal>, "write">,
    value: string,
): Promise<void> {
    for (const character of value) {
        terminal.write(character);
        await delay(1);
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

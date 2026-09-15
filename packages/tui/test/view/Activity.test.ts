import assert from "node:assert/strict";
import test from "node:test";
import {
    asInstanceName,
    type ArtifactShareResult,
    type ArtifactTransferRecord,
    type JsonValue,
} from "@portable-devshell/shared";
import {
    buildFocusGraphForState,
    TuiCommandDispatcher,
    selectMainScreenModel,
    TuiAppStore,
    TuiControlSession,
    TuiFocusManager,
    topTuiOverlay,
    tuiViewProjection,
} from "@portable-devshell/tui/testing";
import { projectAuditContexts } from "../../src/view/page/activity/audit/projection/Context.ts";
import { PassThrough } from "node:stream";
import { type WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    selectTuiMessageEntries,
    selectTuiMessageHistorySessions,
    selectTuiMessageSessions,
    selectTuiMessagesSidebarEntries,
    tuiMessagesHistoryRows,
    tuiMessagesRenderedHistoryRows,
} from "../../src/view/page/activity/messages/Projection.ts";
import { TuiMessagesView } from "../../src/view/page/activity/messages/View.tsx";
import { TuiRootLayout } from "../../src/view/shell/Layout.tsx";

{
    const share: ArtifactShareResult = {
        blake3: "a".repeat(64),
        bytes: 10,
        downloadName: "result.bin",
        expiresAtMs: Date.now() + 60_000,
        mediaType: "application/octet-stream",
        shareId: "share-12345678",
        source: {
            instance: "instance-a",
            path: "./result.bin",
            type: "file",
            workspace: "/projects/a",
        },
        state: "active",
        url: "https://example.test/artifacts/share/token",
    };

    const transfer: ArtifactTransferRecord = {
        createdAt: "2026-07-13T00:00:00.000Z",
        source: {
            instance: "instance-a",
            path: "./result.bin",
            type: "file",
            workspace: "/projects/a",
        },
        status: "transferring",
        target: {
            instance: "instance-b",
            path: "./result.bin",
            workspace: "/projects/b",
        },
        totalBytes: 10,
        transferId: "transfer-12345678",
        transferredBytes: 4,
        updatedAt: "2026-07-13T00:00:01.000Z",
    };

    function toJsonValue(value: unknown): JsonValue {
        return JSON.parse(JSON.stringify(value)) as JsonValue;
    }

    test("TUI startup pulls artifact shares and transfers from Control", async () => {
        const store = new TuiAppStore();
        const session = new TuiControlSession({
            clients: {
                artifact: {
                    async listShares() {
                        return [share];
                    },
                    async listTransfers() {
                        return [transfer];
                    },
                },
                close() {},
                onTransportClose() {
                    return () => undefined;
                },
                config: {
                    async get() {
                        return {};
                    },
                },
                instance: {
                    async list() {
                        return [];
                    },
                },
                mcp: {
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
                service: {
                    async hello() {
                        return {
                            capabilities: ["request", "stream", "streamResume"],
                            protocolVersion: 1,
                        };
                    },
                    async ping() {
                        return { pong: true };
                    },
                },
            } as never,
            store,
        });

        await session.start();
        await waitFor(
            () =>
                store.getState().readModel.artifactShares.length === 1 &&
                store.getState().readModel.artifactTransfers.length === 1,
        );
        assert.deepEqual(store.getState().readModel.artifactShares, [share]);
        assert.deepEqual(store.getState().readModel.artifactTransfers, [
            transfer,
        ]);
        await session.stop();
    });

    test("TUI clears an OAuth polling failure after the background refresh recovers", async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        const store = new TuiAppStore();
        let approvalReads = 0;
        const session = new TuiControlSession({
            clients: {
                artifact: {
                    async listShares() {
                        return [];
                    },
                    async listTransfers() {
                        return [];
                    },
                },
                close() {},
                onTransportClose() {
                    return () => undefined;
                },
                config: {
                    async get() {
                        return { mcp: { enabled: true } };
                    },
                },
                instance: {
                    async list() {
                        return [];
                    },
                },
                mcp: {
                    async listApprovals() {
                        approvalReads += 1;
                        if (approvalReads === 2)
                            throw new Error("OAuth service unavailable");
                        return [];
                    },
                    async status() {
                        return {
                            authMode: "oauth2",
                            oauthReady: true,
                            running: true,
                        };
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
                            health: "healthy" as const,
                            instances: [],
                            todos: [],
                        };
                    },
                },
                async reconnect() {},
                service: {
                    async hello() {
                        return {
                            capabilities: ["request", "stream", "streamResume"],
                            protocolVersion: 1,
                        };
                    },
                    async ping() {
                        return { pong: true };
                    },
                },
            } as never,
            store,
        });

        try {
            await session.start();
            await waitFor(() => approvalReads >= 1);
            t.mock.timers.tick(1_000);
            await waitFor(
                () =>
                    store.getState().panelErrors["connections:-:oauth"] !==
                    undefined,
            );

            assert.equal(
                store.getState().panelErrors["connections:-:oauth"]?.message,
                "OAuth service unavailable",
            );
            assert.equal(store.getState().connection.status, "connected");
            t.mock.timers.tick(1_000);
            await waitFor(
                () =>
                    approvalReads >= 3 &&
                    store.getState().panelErrors["connections:-:oauth"] ===
                        undefined,
            );
        } finally {
            await session.stop();
        }
    });

    test("TUI stops OAuth polling after a connection refresh fails", async (t) => {
        t.mock.timers.enable({ apis: ["setInterval"] });
        let approvalReads = 0;
        let failPing = false;
        const session = new TuiControlSession({
            clients: sessionClients({
                config: {
                    async get() {
                        return { mcp: { enabled: true } };
                    },
                },
                mcp: {
                    async listApprovals() {
                        approvalReads += 1;
                        return [];
                    },
                    async status() {
                        return {
                            authMode: "oauth2",
                            oauthReady: true,
                            running: true,
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
                        if (failPing) throw new Error("control unavailable");
                        return { pong: true };
                    },
                },
            }),
        });

        try {
            await session.start();
            failPing = true;
            await session.refresh();
            const readsAfterFailure = approvalReads;
            t.mock.timers.tick(2_000);

            assert.equal(session.store.getState().connection.status, "error");
            assert.equal(approvalReads, readsAfterFailure);
        } finally {
            await session.stop();
        }
    });

    test("TUI ignores an old visible Overview failure after reconnect", async () => {
        let rejectOldOverview!: (error: Error) => void;
        const oldOverview = new Promise<never>((_resolve, reject) => {
            rejectOldOverview = reject;
        });
        let useOldOverview = false;
        let oldOverviewReads = 0;
        const session = new TuiControlSession({
            clients: sessionClients({
                overview: {
                    async get() {
                        if (useOldOverview) {
                            oldOverviewReads += 1;
                            return await oldOverview;
                        }
                        return {
                            activity: [],
                            alerts: [],
                            controller: { pid: 1, uptimeSeconds: 1 },
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
                            health: "healthy" as const,
                            instances: [],
                            todos: [],
                        };
                    },
                },
            }),
            overviewRefreshIntervalMs: 10,
        });

        try {
            await session.start();
            session.store.setSelectedPage("overview");
            useOldOverview = true;
            const staleRefresh = session.refreshOverview();
            await waitFor(() => oldOverviewReads === 1);
            useOldOverview = false;
            await session.reconnect();
            rejectOldOverview(new Error("stale overview failure"));
            await staleRefresh;

            assert.equal(
                session.store.getState().interaction.screenStatusByPage
                    .overview,
                undefined,
            );
        } finally {
            await session.stop();
        }
    });
    test("instance box shows artifact activity and confirms revoke or cancel before dispatch", async () => {
        const store = seededStore();
        const revoked: string[] = [];
        const cancelled: string[] = [];
        const focusManager = new TuiFocusManager(store, {
            boxIdForLine: (lineId) =>
                selectMainScreenModel(store.getState()).boxes.find((box) =>
                    box.expandedLines.some((line) => line.id === lineId),
                )?.id,
            currentPage: () => store.getState().ui.selectedPage,
            expandedKeyFor: (boxId) =>
                selectMainScreenModel(store.getState()).boxes.find(
                    (box) => box.id === boxId,
                )?.expandedKey,
            graphFor: (page, mode) =>
                buildFocusGraphForState({
                    ...store.getState(),
                    interaction: {
                        ...store.getState().interaction,
                        focusScope: mode,
                    },
                    ui: { ...store.getState().ui, selectedPage: page },
                }),
            mode: () => store.getState().interaction.focusScope,
        });
        const dispatcher = new TuiCommandDispatcher({
            focusManager,
            mainViewportRows: () => 20,
            projection: tuiViewProjection,
            onApprovalDecision: async () => undefined,
            onArtifactCancelTransfer: async (transferId) => {
                cancelled.push(transferId);
            },
            onArtifactRevokeShare: async (shareId) => {
                revoked.push(shareId);
            },
            onOpenTerminal: async () => undefined,
            onInstanceAction: async () => undefined,
            onLogsReload: async () => undefined,
            onPageReload: async () => undefined,
            onQuit: async () => undefined,
            onRedraw: () => undefined,
            onToolCall: async () => true,
            store,
        });

        const box = selectMainScreenModel(store.getState()).boxes.find(
            (candidate) => candidate.id === "instance:instance-a",
        )!;
        assert.match(
            box.collapsedLines[1]?.text ?? "",
            /artifacts shares=1 transfers=1 active=2/u,
        );
        assert.equal(
            box.expandedLines.some((line) => line.text.includes("/projects/a")),
            true,
        );
        assert.equal(
            box.expandedLines.some((line) => line.text.includes("/projects/b")),
            true,
        );
        const revokeLine = box.expandedLines.find((line) =>
            line.id?.includes("button:artifact-revoke:"),
        );
        const cancelLine = box.expandedLines.find((line) =>
            line.id?.includes("button:artifact-cancel:"),
        );
        assert.ok(revokeLine?.id);
        assert.ok(cancelLine?.id);

        store.setFocusScope("boxDetail");
        store.setSelectedDetailLine(box.expandedKey, revokeLine.id);
        await dispatcher.dispatch({ type: "focus.activate" });
        let overlay = topTuiOverlay(store.getState().interaction.overlays);
        assert.equal(overlay?.kind, "confirmation");
        assert.equal(
            overlay?.kind === "confirmation"
                ? overlay.selectedAction
                : undefined,
            "cancel",
        );
        assert.deepEqual(revoked, []);
        await dispatcher.dispatch({ button: "confirm", type: "confirm.focus" });
        await dispatcher.dispatch({ type: "confirm.accept" });
        assert.deepEqual(revoked, [share.shareId]);

        store.setFocusScope("boxDetail");
        store.setSelectedDetailLine(box.expandedKey, cancelLine.id);
        await dispatcher.dispatch({ type: "focus.activate" });
        overlay = topTuiOverlay(store.getState().interaction.overlays);
        assert.equal(
            overlay?.kind === "confirmation"
                ? overlay.selectedAction
                : undefined,
            "cancel",
        );
        await dispatcher.dispatch({ button: "confirm", type: "confirm.focus" });
        await dispatcher.dispatch({ type: "confirm.accept" });
        assert.deepEqual(cancelled, [transfer.transferId]);
    });

    function seededStore(): TuiAppStore {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instances: [
                {
                    homeDirectory: "/workspace/a",
                    enabled: true,
                    mcpEnabled: true,
                    name: "instance-a",
                    provider: "local",
                },
            ],
        });
        store.patchControlSnapshot({
            connectionState: "connected",
            daemonState: "running",
            lastSeq: 0,
            name: asInstanceName("instance-a"),
            ready: true,
            status: "ready",
        });
        store.patchControlReadModel({ artifactShares: [share] });
        store.patchControlReadModel({ artifactTransfers: [transfer] });
        store.setSelectedPage("instances");
        store.setSelectedInstance("instance-a");
        store.setMainFocusId("instance:instance-a");
        store.toggleExpanded("instances:instance-a:instance");
        return store;
    }

    async function waitFor(predicate: () => boolean): Promise<void> {
        const deadline = Date.now() + 2_000;
        while (!predicate()) {
            if (Date.now() > deadline) {
                throw new Error("Timed out waiting for TUI state.");
            }
            await new Promise<void>((resolve) => setImmediate(resolve));
        }
    }

    function sessionClients(overrides: Record<string, unknown> = {}) {
        return {
            artifact: {
                async listShares() {
                    return [];
                },
                async listTransfers() {
                    return [];
                },
            },
            close() {},
            onTransportClose() {
                return () => undefined;
            },
            config: {
                async get() {
                    return {};
                },
            },
            instance: {
                async list() {
                    return [];
                },
            },
            mcp: {
                async status() {
                    return {};
                },
            },
            overview: {
                async get() {
                    return {
                        activity: [],
                        alerts: [],
                        controller: { pid: 1, uptimeSeconds: 1 },
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
                        health: "healthy" as const,
                        instances: [],
                        todos: [],
                    };
                },
            },
            async reconnect() {},
            service: {
                async hello() {
                    return {
                        capabilities: ["request", "stream", "streamResume"],
                        protocolVersion: 1,
                    };
                },
                async ping() {
                    return { pong: true };
                },
            },
            ...overrides,
        } as never;
    }
}

{
    test("Audit excludes caller-recorded delegated Worker activity", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instanceState: {
                alpha: {
                    approvals: [
                        {
                            approvalId: "approval-agent",
                            callId: "call-agent",
                            createdAt: "2026-09-10T12:00:00.000Z",
                            ctxId: "ext-agent-session",
                            expiresAt: "2026-09-10T12:05:00.000Z",
                            extensionId: "agent",
                            inputSummary: "{}",
                            instance: asInstanceName("alpha"),
                            reason: "Approval required.",
                            recording: "caller",
                            riskLevel: "medium",
                            source: "extension",
                            status: "pending",
                            toolName: "file_read",
                            workspace: "/workspace",
                        },
                        {
                            approvalId: "approval-host",
                            callId: "call-host",
                            createdAt: "2026-09-10T12:01:00.000Z",
                            ctxId: "ctx-host",
                            expiresAt: "2026-09-10T12:06:00.000Z",
                            inputSummary: "{}",
                            instance: asInstanceName("alpha"),
                            reason: "Approval required.",
                            recording: "host",
                            riskLevel: "medium",
                            source: "mcp",
                            status: "pending",
                            toolName: "bash_run",
                            workspace: "/workspace",
                        },
                    ],
                },
            },
        });

        assert.equal(
            store.getState().readModel.instanceState.alpha?.approvals.length,
            2,
        );
        assert.deepEqual(
            projectAuditContexts(store.getState(), "alpha").map((context) =>
                context.key.kind === "context" ? context.key.ctxId : "unscoped",
            ),
            ["ctx-host"],
        );
    });
}

{
    test("Messages merges registered sessions with exact comment and report history", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            contexts: [
                {
                    createdAt: "2026-09-10T10:00:00.000Z",
                    ctxId: "ctx-alpha",
                    environments: [
                        { instance: "alpha", workspace: "/workspace/project" },
                    ],
                    expiresAt: "2099-09-10T10:00:00.000Z",
                    instance: "alpha",
                    lastAccessedAt: "2026-09-10T10:02:00.000Z",
                    principal: "client",
                    status: "active",
                    workspace: "/workspace/project",
                },
                {
                    createdAt: "2026-09-10T09:00:00.000Z",
                    ctxId: "ctx-empty",
                    environments: [
                        { instance: "alpha", workspace: "/workspace/empty" },
                    ],
                    expiresAt: "2099-09-10T10:00:00.000Z",
                    instance: "alpha",
                    lastAccessedAt: "2026-09-10T10:04:00.000Z",
                    principal: "client",
                    status: "active",
                    workspace: "/workspace/empty",
                },
            ],
            instanceState: {
                alpha: {
                    conversationEntries: [
                        {
                            createdAt: "2026-09-10T10:03:00.000Z",
                            ctxId: "ctx-alpha",
                            id: "comment-1",
                            kind: "comment",
                            status: "sent",
                            text: "user comment",
                        },
                        {
                            callId: "report-1",
                            createdAt: "2026-09-10T10:04:00.000Z",
                            ctxId: "ctx-alpha",
                            id: "report-1",
                            kind: "report",
                            text: "agent report",
                        },
                    ],
                    contextMessages: [
                        {
                            createdAt: "2026-09-10T10:03:00.000Z",
                            ctxId: "ctx-alpha",
                            id: "comment-1",
                            instance: "alpha",
                            status: "sent",
                            text: "user comment",
                        },
                    ],
                    reportCalls: [
                        {
                            callId: "report-1",
                            completedAt: "2026-09-10T10:04:00.000Z",
                            ctxId: "ctx-alpha",
                            input: { message: "agent report" },
                            inputSummary: '{"message":"agent report"}',
                            instance: asInstanceName("alpha"),
                            source: "mcp",
                            startedAt: "2026-09-10T10:03:59.000Z",
                            status: "completed",
                            toolName: "todo_report",
                        },
                    ],
                },
            },
        });
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        const now = Date.parse("2026-09-10T10:05:00.000Z");

        assert.deepEqual(
            selectTuiMessageSessions(store.getState(), "alpha", now).map(
                (session) => session.ctxId,
            ),
            ["ctx-alpha", "ctx-empty"],
        );
        assert.deepEqual(
            selectTuiMessageEntries(store.getState(), "alpha", "ctx-alpha").map(
                (entry) => [entry.kind, entry.text],
            ),
            [
                ["comment", "user comment"],
                ["report", "agent report"],
            ],
        );
        assert.deepEqual(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                true,
                { id: "messages:back", kind: "context" },
                now,
            ).map((entry) => entry.label),
            ["← messages", "History", "project", "empty"],
        );
    });

    test("Messages hides sessions that were inactive for more than 30 minutes", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            contexts: [
                {
                    createdAt: "2026-09-10T10:00:00.000Z",
                    ctxId: "ctx-recent",
                    environments: [
                        { instance: "alpha", workspace: "/workspace/recent" },
                    ],
                    expiresAt: "2099-09-10T10:00:00.000Z",
                    instance: "alpha",
                    lastAccessedAt: "2026-09-10T10:02:00.000Z",
                    principal: "client",
                    status: "active",
                    workspace: "/workspace/recent",
                },
                {
                    createdAt: "2026-09-10T09:00:00.000Z",
                    ctxId: "ctx-stale",
                    environments: [
                        { instance: "alpha", workspace: "/workspace/stale" },
                    ],
                    expiresAt: "2099-09-10T10:00:00.000Z",
                    instance: "alpha",
                    lastAccessedAt: "2026-09-10T09:20:00.000Z",
                    principal: "client",
                    status: "active",
                    workspace: "/workspace/stale",
                },
            ],
        });
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        const now = Date.parse("2026-09-10T10:05:00.000Z");

        assert.deepEqual(
            selectTuiMessageSessions(store.getState(), "alpha", now).map(
                (session) => session.ctxId,
            ),
            ["ctx-recent"],
        );
        assert.deepEqual(
            selectTuiMessageHistorySessions(store.getState(), "alpha", now).map(
                (session) => session.ctxId,
            ),
            ["ctx-stale"],
        );
        assert.deepEqual(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                true,
                { id: "messages:back", kind: "context" },
                now,
            ).map((entry) => entry.label),
            ["← messages", "History", "recent"],
        );

        store.setMessageScope("history");
        assert.deepEqual(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                true,
                { id: "messages:scope", kind: "context" },
                now,
            ).map((entry) => entry.label),
            ["← messages", "Active", "stale"],
        );
    });

    test("Messages empty state explains the selected Conversation scope", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instances: [{ enabled: true, mcpEnabled: true, name: "alpha" }],
        });
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");

        let view = TuiMessagesView({
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        assert.match(
            String(view.props.children[1].props.children),
            /No active conversations on alpha/u,
        );
        assert.match(String(view.props.children[1].props.children), /History/u);

        store.setMessageScope("history");
        view = TuiMessagesView({
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        assert.match(
            String(view.props.children[1].props.children),
            /No conversation history on alpha/u,
        );
    });

    test("Messages keeps a fixed history viewport so the frame and composer do not move", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instanceState: {
                alpha: {
                    conversationEntries: [
                        {
                            createdAt: "2026-09-10T10:03:00.000Z",
                            ctxId: "ctx-alpha",
                            id: "comment-1",
                            kind: "comment",
                            status: "delivered",
                            text: "short history",
                        },
                    ],
                },
            },
        });
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        store.replaceRoute({
            ctxId: "ctx-alpha",
            page: "messages",
            view: "thread",
        });

        const view = TuiMessagesView({
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        const history = view.props.children[0];
        assert.equal(
            view.props.flexGrow,
            1,
            "Messages content must fill the main panel",
        );
        assert.equal(history.props.height, tuiMessagesHistoryRows(30));
        assert.equal(history.props.justifyContent, undefined);
        assert.equal(
            tuiMessagesRenderedHistoryRows(200, 30),
            tuiMessagesHistoryRows(30),
        );

        const layout = TuiRootLayout({
            columns: 120,
            footer: "footer",
            header: "header",
            main: view,
            rows: 40,
            sidebar: "sidebar",
        });
        const middle = layout.props.children[1];
        const mainPanel = middle.props.children[3];
        assert.equal(mainPanel.props.alignSelf, undefined);
    });

    test("Messages Ink frame reserves one physical separator row per conversation entry", async () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instanceState: {
                alpha: {
                    conversationEntries: Array.from(
                        { length: 8 },
                        (_, index) => ({
                            createdAt: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
                            ctxId: "ctx-alpha",
                            id: `comment-${index}`,
                            kind: "comment" as const,
                            status: "delivered" as const,
                            text: `frame comment ${index}`,
                        }),
                    ),
                },
            },
        });
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        store.replaceRoute({
            ctxId: "ctx-alpha",
            page: "messages",
            view: "thread",
        });

        const output = new PassThrough() as PassThrough & {
            columns: number;
            isTTY: true;
            rows: number;
        };
        output.columns = 80;
        output.isTTY = true;
        output.rows = 30;
        let captured = "";
        output.on("data", (chunk) => {
            captured += chunk.toString();
        });
        const ink = render(
            TuiMessagesView({
                state: store.getState(),
                viewportRows: 30,
                width: 80,
            }),
            { debug: true, stdout: output as unknown as WriteStream },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        ink.cleanup();

        const lines = stripVTControlCharacters(captured).split("\n");
        const lastBodyRow = lines.reduce(
            (latest, line, index) =>
                line.includes("frame comment") ? index : latest,
            -1,
        );
        const composerRow = lines.findIndex((line) =>
            line.includes("> Write a comment"),
        );
        assert.notEqual(lastBodyRow, -1);
        assert.notEqual(composerRow, -1);
        assert.equal(composerRow, tuiMessagesHistoryRows(30) + 1);
    });

    test("Messages composer owns an inline cursor cell", () => {
        assert.deepEqual(renderTuiMessageComposerSegments("中文", 1, true), [
            { text: "中" },
            { text: "文", underline: true },
            { text: "" },
        ]);
        assert.deepEqual(renderTuiMessageComposerSegments("中文", 2, false), [
            { text: "中文" },
            { text: " ", underline: undefined },
            { text: "" },
        ]);
        assert.deepEqual(renderTuiMessageComposerSegments("👩‍💻x", 0, true), [
            { text: "" },
            { text: "👩‍💻", underline: true },
            { text: "x" },
        ]);
    });

    test("Messages reuses wrapped history while only editor state changes", () => {
        const store = new TuiAppStore();
        store.patchControlReadModel({
            instanceState: {
                alpha: {
                    conversationEntries: [
                        {
                            createdAt: "2026-09-10T10:03:00.000Z",
                            ctxId: "ctx-alpha",
                            id: "comment-1",
                            kind: "comment",
                            status: "delivered",
                            text: "history ".repeat(200),
                        },
                    ],
                },
            },
        });
        const first = renderTuiMessageHistoryLines(
            store.getState(),
            "alpha",
            "ctx-alpha",
            80,
        );
        store.setFormDraft("messages:alpha:ctx-alpha", "editing", true);
        const second = renderTuiMessageHistoryLines(
            store.getState(),
            "alpha",
            "ctx-alpha",
            80,
        );
        assert.equal(
            second,
            first,
            "editing must not re-wrap unchanged conversation history",
        );
    });
}

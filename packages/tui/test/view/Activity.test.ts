import assert from "node:assert/strict";
import test from "node:test";
import {
    asInstanceName,
    type ArtifactShareResult,
    type ArtifactTransferRecord,
} from "@portable-devshell/shared";
import {
    buildFocusGraphForState,
    TuiCommandDispatcher,
    selectMainScreenModel,
    TuiAppStore,
    TuiFocusManager,
    topTuiOverlay,
} from "@portable-devshell/tui/testing";
import { TuiTestDomains } from "../support/DomainHarness.ts";
import { projectAuditContexts } from "../../src/state/route/Audit.ts";
import { buildAuditContextBoxes } from "../../src/view/page/activity/audit/Context.ts";
import { PassThrough } from "node:stream";
import { type WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import {
    renderTuiMessageComposerSegments,
    renderTuiMessageHistoryLines,
    selectTuiMessageEntries,
    selectTuiMessageHiddenSessions,
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

    test("instance box shows artifact activity and confirms revoke or cancel before dispatch", async () => {
        const domains = new TuiTestDomains();
        const store = seededStore(domains);
        const revoked: string[] = [];
        const cancelled: string[] = [];
        const focusManager = new TuiFocusManager(store, {
            boxIdForLine: (lineId) =>
                selectMainScreenModel(
                    store.getState(),
                    domains.reader,
                ).boxes.find((box) =>
                    box.expandedLines.some((line) => line.id === lineId),
                )?.id,
            currentPage: () => store.getState().ui.selectedPage,
            expandedKeyFor: (boxId) =>
                selectMainScreenModel(
                    store.getState(),
                    domains.reader,
                ).boxes.find((box) => box.id === boxId)?.expandedKey,
            graphFor: (page, mode) =>
                buildFocusGraphForState(
                    {
                        ...store.getState(),
                        interaction: {
                            ...store.getState().interaction,
                            focusScope: mode,
                        },
                        ui: { ...store.getState().ui, selectedPage: page },
                    },
                    domains.reader,
                ),
            mode: () => store.getState().interaction.focusScope,
        });
        const dispatcher = new TuiCommandDispatcher({
            focusManager,
            mainViewportRows: () => 20,
            projection: domains.projection,
            onApprovalDecision: async () => undefined,
            onArtifactCancelTransfer: async (transferId) => {
                cancelled.push(transferId);
            },
            onArtifactRevokeShare: async (shareId) => {
                revoked.push(shareId);
            },
            onOpenTerminal: async () => undefined,
            onInstanceAction: async () => undefined,
            onPageReload: async () => undefined,
            onQuit: async () => undefined,
            onRedraw: () => undefined,
            onToolCall: async () => true,
            store,
        });

        const box = selectMainScreenModel(
            store.getState(),
            domains.reader,
        ).boxes.find((candidate) => candidate.id === "instance:instance-a")!;
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

    function seededStore(domains: TuiTestDomains): TuiAppStore {
        const store = new TuiAppStore();
        domains.setInstances([
            {
                enabled: true,
                homeDirectory: "/workspace/a",
                mcpEnabled: true,
                name: "instance-a",
                provider: "local",
            },
        ]);
        domains.setArtifacts({
            shares: [share],
            transfers: [transfer],
        });
        store.setSelectedPage("instances");
        store.setSelectedInstance("instance-a");
        store.setMainFocusId("instance:instance-a");
        store.toggleExpanded("instances:instance-a:instance");
        return store;
    }
}

{
    test("Audit shows the selected Context's scoped pages instead of the instance preview", () => {
        const domains = new TuiTestDomains();
        domains.setContexts(["ctx-history", "ctx-quiet"].map((ctxId) => ({
            createdAt: "2026-10-26T00:00:00Z",
            ctxId,
            environments: [{ instance: "alpha", workspace: `/workspace/${ctxId}` }],
            expiresAt: "2026-11-26T00:00:00Z",
            lastAccessedAt: "2026-10-26T00:00:00Z",
            principal: "client",
            status: "active",
        })));
        const calls = Array.from({ length: 230 }, (_, index) => ({
            callId: `call-${index}`,
            ctxId: "ctx-history",
            inputSummary: "{}",
            instance: asInstanceName("alpha"),
            source: "mcp" as const,
            startedAt: new Date(1_790_000_000_000 + index * 1000).toISOString(),
            status: "completed" as const,
            toolName: "bash_run",
        }));
        domains.setToolCalls("alpha", calls.slice(-2));
        domains.toolCalls.patch({ context: {
            calls, ctxId: "ctx-history", instance: "alpha", loading: false,
            historyBefore: calls[0]!.callId, historyExhausted: false,
        } });
        const contexts = projectAuditContexts(domains.reader, "alpha");
        assert.equal(contexts.find((item) => item.key.kind === "context" && item.key.ctxId === "ctx-history")?.calls.length, 230);
        assert.equal(contexts.find((item) => item.key.kind === "context" && item.key.ctxId === "ctx-quiet")?.calls.length, 0);

        const store = new TuiAppStore();
        store.setSelectedInstance("alpha");
        store.setSelectedPage("audit");
        const boxes = buildAuditContextBoxes(store.getState(), domains.reader, "alpha", {
            kind: "context", ctxId: "ctx-history",
        });
        assert.equal(boxes.filter((box) => box.id.startsWith("audit-call:")).length, 230);
        assert.equal(boxes.some((box) => box.id === "audit-context-older"), true);
    });

    test("Audit excludes caller-recorded delegated Worker activity", () => {
        const domains = new TuiTestDomains();
        domains.setApprovals("alpha", [
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
        ]);

        assert.equal(domains.reader.approval("alpha").approvals.length, 2);
        assert.deepEqual(
            projectAuditContexts(domains.reader, "alpha").map((context) =>
                context.key.kind === "context" ? context.key.ctxId : "unscoped",
            ),
            ["ctx-host"],
        );
    });
}

{
    test("Messages merges registered sessions with exact comment and report history", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setInstances([
            { enabled: true, mcpEnabled: true, name: "alpha", provider: "local" },
        ]);
        domains.setContexts([
            {
                createdAt: "2026-09-10T10:00:00.000Z",
                ctxId: "ctx-alpha",
                environments: [
                    { instance: "alpha", workspace: "/workspace/project" },
                ],
                expiresAt: "2099-09-10T10:00:00.000Z",
                lastAccessedAt: "2026-09-10T10:02:00.000Z",
                principal: "client",
                status: "active",
            },
            {
                createdAt: "2026-09-10T09:00:00.000Z",
                ctxId: "ctx-empty",
                environments: [
                    { instance: "alpha", workspace: "/workspace/empty" },
                ],
                expiresAt: "2099-09-10T10:00:00.000Z",
                lastAccessedAt: "2026-09-10T10:04:00.000Z",
                principal: "client",
                status: "active",
            },
        ]);
        domains.setMessageHistory("alpha", [
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
        ]);
        domains.setMessages("alpha", [
            {
                createdAt: "2026-09-10T10:03:00.000Z",
                ctxId: "ctx-alpha",
                id: "comment-1",
                instance: "alpha",
                status: "sent",
                text: "user comment",
            },
        ]);
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        const now = Date.parse("2026-09-10T10:05:00.000Z");

        assert.deepEqual(
            selectTuiMessageSessions(domains.reader, now).map(
                (session) => session.ctxId,
            ),
            ["ctx-empty", "ctx-alpha"],
        );
        assert.deepEqual(
            selectTuiMessageEntries(domains.reader, "alpha", "ctx-alpha").map(
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
                domains.reader,
                true,
                { id: "messages:back", kind: "context" },
                now,
            ).map((entry) => entry.label),
            [
                "← messages",
                "Current",
                "History",
                "Hidden",
                "▾ empty",
                "  empty",
                "▾ project",
                "  user comment",
            ],
        );
    });

    test("Messages applies server titles and hidden ctxId preferences", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        const now = new Date().toISOString();
        domains.setContexts([
            {
                createdAt: now,
                ctxId: "ctx-visible",
                environments: [
                    { instance: "alpha", workspace: "/workspace/project" },
                ],
                expiresAt: "2099-01-01T00:00:00.000Z",
                lastAccessedAt: now,
                principal: "client",
                status: "active",
            },
            {
                createdAt: now,
                ctxId: "ctx-hidden",
                environments: [
                    { instance: "beta", workspace: "/workspace/hidden" },
                ],
                expiresAt: "2099-01-01T00:00:00.000Z",
                lastAccessedAt: now,
                principal: "client",
                status: "active",
            },
        ]);
        domains.setMessagePreferences({
            ...domains.messagePreferences.state.preferences,
            hiddenContexts: { "ctx-hidden": true },
            titles: { "alpha\u0000ctx-visible": "Pinned message" },
        });
        store.setSelectedPage("messages");

        assert.deepEqual(
            selectTuiMessageSessions(domains.reader).map((session) => [
                session.ctxId,
                session.title,
            ]),
            [["ctx-visible", "Pinned message"]],
        );
        assert.deepEqual(
            selectTuiMessageHiddenSessions(domains.reader).map(
                (session) => session.ctxId,
            ),
            ["ctx-hidden"],
        );
        assert.equal(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                domains.reader,
                true,
                {
                    id: "messages:back",
                    kind: "context",
                },
            ).some((entry) => entry.label === "  Pinned message"),
            true,
        );

        store.setMessageScope("hidden");
        assert.equal(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                domains.reader,
                true,
                {
                    id: "messages:scope:hidden",
                    kind: "context",
                },
            ).some((entry) => entry.label === "  hidden"),
            true,
        );
    });

    test("Messages hides sessions that were inactive for more than 30 minutes", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setContexts([
            {
                createdAt: "2026-09-10T10:00:00.000Z",
                ctxId: "ctx-recent",
                environments: [
                    { instance: "alpha", workspace: "/workspace/recent" },
                ],
                expiresAt: "2099-09-10T10:00:00.000Z",
                lastAccessedAt: "2026-09-10T10:02:00.000Z",
                principal: "client",
                status: "active",
            },
            {
                createdAt: "2026-09-10T09:00:00.000Z",
                ctxId: "ctx-stale",
                environments: [
                    { instance: "alpha", workspace: "/workspace/stale" },
                ],
                expiresAt: "2099-09-10T10:00:00.000Z",
                lastAccessedAt: "2026-09-10T09:20:00.000Z",
                principal: "client",
                status: "active",
            },
        ]);
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        const now = Date.parse("2026-09-10T10:05:00.000Z");

        assert.deepEqual(
            selectTuiMessageSessions(domains.reader, now).map(
                (session) => session.ctxId,
            ),
            ["ctx-recent"],
        );
        assert.deepEqual(
            selectTuiMessageHistorySessions(domains.reader, now).map(
                (session) => session.ctxId,
            ),
            ["ctx-stale"],
        );
        assert.deepEqual(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                domains.reader,
                true,
                { id: "messages:back", kind: "context" },
                now,
            ).map((entry) => entry.label),
            [
                "← messages",
                "Current",
                "History",
                "Hidden",
                "▾ recent",
                "  recent",
            ],
        );

        store.setMessageScope("history");
        assert.deepEqual(
            selectTuiMessagesSidebarEntries(
                store.getState(),
                domains.reader,
                true,
                { id: "messages:scope:history", kind: "context" },
                now,
            ).map((entry) => entry.label),
            [
                "← messages",
                "Current",
                "History",
                "Hidden",
                "▾ stale",
                "  stale",
            ],
        );
    });

    test("Messages empty state explains the selected Message scope", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setInstances([
            { enabled: true, mcpEnabled: true, name: "alpha" },
        ]);
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");

        let view = TuiMessagesView({
            reader: domains.reader,
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        assert.match(
            String(view.props.children[1].props.children),
            /No current messages/u,
        );
        assert.match(String(view.props.children[1].props.children), /Hidden/u);

        store.setMessageScope("history");
        view = TuiMessagesView({
            reader: domains.reader,
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        assert.match(
            String(view.props.children[1].props.children),
            /No message history/u,
        );

        store.setMessageScope("hidden");
        view = TuiMessagesView({
            reader: domains.reader,
            state: store.getState(),
            viewportRows: 30,
            width: 80,
        });
        assert.match(
            String(view.props.children[1].props.children),
            /No hidden messages/u,
        );
    });

    test("Messages keeps a fixed history viewport so the frame and composer do not move", () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setMessageHistory("alpha", [
            {
                createdAt: "2026-09-10T10:03:00.000Z",
                ctxId: "ctx-alpha",
                id: "comment-1",
                kind: "comment",
                status: "delivered",
                text: "short history",
            },
        ]);
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        store.replaceRoute({
            ctxId: "ctx-alpha",
            instance: "alpha",
            page: "messages",
            view: "thread",
        });

        const view = TuiMessagesView({
            reader: domains.reader,
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

    test("Messages Ink frame reserves one physical separator row per message entry", async () => {
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setMessageHistory(
            "alpha",
            Array.from({ length: 8 }, (_, index) => ({
                createdAt: `2026-09-10T10:${String(index).padStart(2, "0")}:00.000Z`,
                ctxId: "ctx-alpha",
                id: `comment-${index}`,
                kind: "comment" as const,
                status: "delivered" as const,
                text: `frame comment ${index}`,
            })),
        );
        store.setSelectedInstance("alpha");
        store.setSelectedPage("messages");
        store.replaceRoute({
            ctxId: "ctx-alpha",
            instance: "alpha",
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
                reader: domains.reader,
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
        const domains = new TuiTestDomains();
        const store = new TuiAppStore();
        domains.setMessageHistory("alpha", [
            {
                createdAt: "2026-09-10T10:03:00.000Z",
                ctxId: "ctx-alpha",
                id: "comment-1",
                kind: "comment",
                status: "delivered",
                text: "history ".repeat(200),
            },
        ]);
        const first = renderTuiMessageHistoryLines(
            domains.reader,
            "alpha",
            "ctx-alpha",
            80,
        );
        store.setFormDraft("messages:alpha:ctx-alpha", "editing", true);
        const second = renderTuiMessageHistoryLines(
            domains.reader,
            "alpha",
            "ctx-alpha",
            80,
        );
        assert.equal(
            second,
            first,
            "editing must not re-wrap unchanged message history",
        );
    });
}

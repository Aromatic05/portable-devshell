import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { TuiKeyDispatcher } from "../../src/interaction/Input.ts";
import { buildTuiHitRegions } from "../../src/view/projection/HitRegion.ts";
import { TuiScreenRouter } from "../../src/view/shell/Router.tsx";
import { TuiOverlayView } from "../../src/view/overlay/View.tsx";
import { TuiComponentTmuxPanes } from "../../src/terminal/tmux/View.tsx";
import { TuiTmuxPaneTerminalSession } from "../../src/terminal/tmux/Session.ts";
import { renderExpandableBoxLines } from "../../src/view/component/content/Box.tsx";
import { currentTuiRoute, reconcileTuiRouteResources } from "../../src/state/route/State.ts";
import { round6Tui } from "../support/Round6Harness.ts";

async function ink(element: ReactElement, columns = 80) {
    const output = new PassThrough(); Object.assign(output, { columns });
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const view = render(element, { stdout: output as unknown as WriteStream,
        debug: true, patchConsole: false, exitOnCtrlC: false });
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup(); output.destroy();
    return stripVTControlCharacters(text);
}
async function press(h: ReturnType<typeof round6Tui>, input: string, key = {}) {
    await h.dispatcher.dispatchMany(new TuiKeyDispatcher().dispatch(
        h.store.getState().interaction.focusScope, { input, key }));
}
const context = { ctxId: "old", createdAt: "2026-01-01T00:00:00Z", lastAccessedAt: "2026-01-01T00:00:00Z",
    environments: [{ instance: "alpha", workspace: "/work" }], status: "active" };

test("T01 Enter navigates a registered Context with no calls in the recent preview", async () => {
    const h = round6Tui(); h.domains.setContexts([context as never]); h.domains.setToolCalls("alpha", []);
    h.store.setSelectedPage("audit"); h.store.setMainFocusId("audit-context:old"); h.store.setFocusScope("mainBoxes");
    await press(h, "", { return: true });
    assert.deepEqual(currentTuiRoute(h.store.getState()), { page: "audit", view: "context", scope: "context", ctxId: "old" });
    const reconciled = reconcileTuiRouteResources(h.store.getState(), h.domains.reader);
    assert.equal(currentTuiRoute(reconciled).view, "context");
});

test("T02 Enter opens Input and Output for an older scoped call outside the preview", async () => {
    const reads: string[] = [];
    const call = { callId: "older-call", ctxId: "old", instance: "alpha", toolName: "bash_run",
        inputSummary: "older summary", status: "completed", source: "mcp", startedAt: "2026-01-01T00:00:00Z" };
    const h = round6Tui({
        onAuditLoadOlder: async () => {
            h.domains.toolCalls.patch({ context: { calls: [call as never], ctxId: "old", instance: "alpha", loading: false } });
            return 1;
        },
        onToolCallDetail: async (_instance, callId) => {
            reads.push(callId);
            return { ...call, input: { command: "historical input" }, output: { text: "historical output" } } as never;
        },
    });
    h.domains.setContexts([context as never]); h.domains.setToolCalls("alpha", []);
    h.domains.toolCalls.patch({ context: { calls: [], ctxId: "old", instance: "alpha", loading: false } });
    h.store.setSelectedPage("audit"); h.store.pushRoute({ page: "audit", view: "context", scope: "context", ctxId: "old" });
    h.store.setFocusScope("mainBoxes");
    await press(h, "l");
    h.store.setMainFocusId("audit-call:older-call");
    const box = h.model().boxes.find((item) => item.id === "audit-call:older-call"); assert.ok(box);
    h.store.toggleExpanded(box.expandedKey); h.store.setFocusScope("mainBoxes");
    for (const action of ["input", "output"]) {
        const expanded = h.model().boxes.find((item) => item.id === box.id)!;
        const line = expanded.expandedLines.find((item) => item.id?.endsWith(`:${action}`)); assert.ok(line?.id);
        h.store.setSelectedDetailLine(box.expandedKey, line.id); await press(h, "", { return: true });
        const overlay = h.store.getState().interaction.overlays.at(-1); assert.equal(overlay?.kind, "text-detail");
        assert.match((overlay as { body: string }).body, new RegExp(`historical ${action}`));
        await press(h, "", { escape: true });
    }
    assert.deepEqual(reads, ["older-call", "older-call"]);
});

test("T05 small approval keeps actions in its viewport and End exposes the final input summary", async () => {
    const h = round6Tui({ mainViewportRows: () => 9, mainContentColumns: () => 76 });
    h.domains.setApprovals("alpha", [{ approvalId: "approval", callId: "call", instance: "alpha", source: "tui",
        toolName: "bash_run", riskLevel: "high", reason: "Long policy explanation ".repeat(18),
        inputSummary: "TAIL-INPUT", createdAt: "2026-01-01T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" } as never]);
    await h.dispatcher.dispatch({ type: "approval.open", instance: "alpha", approvalId: "approval" });
    const screen = () => ink(createElement(TuiOverlayView, { reader: h.domains.reader, state: h.store.getState(), viewportRows: 9, width: 76 }));
    const actions = buildTuiHitRegions(h.store.getState(), h.domains.reader, { columns: 80, rows: 20 })
        .filter((region) => region.target.kind === "overlayAction");
    assert.equal(actions.length, 4);
    assert.ok(actions.every((region) => region.y < 16));
    const first = await screen(); assert.match(first, /Approve/); assert.ok(first.trimEnd().split("\n").length <= 9);
    await press(h, "", { end: true });
    const last = await screen(); assert.match(last, /TAIL-INPUT/); assert.match(last, /Approve/);
    assert.ok(last.trimEnd().split("\n").length <= 9);
    const end = h.store.getState().interaction.overlays.at(-1); assert.ok(end?.kind === "approval");
    await press(h, "", { pageUp: true });
    const overlay = h.store.getState().interaction.overlays.at(-1); assert.ok(overlay?.kind === "approval");
    assert.equal(overlay.scrollOffset, Math.max(0, end.scrollOffset! - 10));
});

test("T06 editable SSH command shows the grapheme under the cursor at its long tail", () => {
    const value = `ssh ${"long-host-".repeat(15)}界😀`;
    const lines = renderExpandableBoxLines({ id: "ssh", title: "SSH", expanded: true, focused: true,
        expandedKey: "ssh", enterable: false, expandable: true, status: "normal", collapsedLines: [{ text: "SSH" }], expandedLines: [{ id: "command", text: value,
            editableValue: { prefix: "command: ", value, kind: "text" }, editing: true, cursorVisible: true, cursor: value.length }],
    }, 60);
    const row = lines.find((line) => line.lineId === "command")!;
    assert.match(row.text, /界😀/); assert.ok(row.segments?.some((segment) => segment.underline && segment.text === " "));
    assert.match(row.text, /‹/);
});

test("T07 actual pane down keys keep the selected row visible beyond a screen", async () => {
    const session = new TuiTmuxPaneTerminalSession({ operations: {
        listPanes: async () => Array.from({ length: 30 }, (_, index) => ({ id: `p${index}`, name: `pane-${index}`, status: "idle", workspace: "/work" })),
        inspectPane: async () => undefined, sendInput: async () => ({ output: [], status: "idle", task: "unused" }),
    } });
    await session.bind("alpha");
    for (let index = 0; index < 22; index++) await session.handleRawInput("\u001b[B");
    assert.equal(session.getSnapshot().selectedIndex, 22);
    const screen = await ink(createElement(TuiComponentTmuxPanes, { columns: 80, rows: 16, focused: true, instance: "alpha", source: session }));
    assert.match(screen, /▶ pane-22/); assert.equal(screen.includes("  pane-0 ·"), false); session.dispose();
});

test("T08 Space expands a long Goal and End reveals the final objective in Ink", async () => {
    const h = round6Tui({ mainViewportRows: () => 14, mainBoxInnerColumns: () => 72 });
    const objective = `Start ${"readable objective ".repeat(50)}FINAL-OBJECTIVE`;
    h.domains.setGoals("alpha", [{ goalId: "goal", objective, status: "active", revision: 1 }]);
    h.store.setSelectedPage("goals"); h.store.setMainFocusId("goal:goal"); h.store.setFocusScope("mainBoxes");
    await press(h, " "); await press(h, "", { end: true });
    const text = await ink(createElement(TuiScreenRouter, { reader: h.domains.reader, state: h.store.getState(), viewportRows: 14, contentWidth: 76, boxInnerWidth: 72 }));
    assert.match(text, /FINAL-OBJECTIVE/);
});

test("X02 history failure renders an error and retry hint instead of an empty thread", async () => {
    const h = round6Tui(); h.domains.setContexts([context as never]);
    h.domains.messageHistory.patch({ context: { instance: "alpha", ctxId: "old", entries: [], loading: false, failure: new Error("history unavailable") } });
    h.store.setSelectedPage("messages"); h.store.pushRoute({ page: "messages", view: "thread", instance: "alpha", ctxId: "old" });
    const screen = await ink(createElement(TuiScreenRouter, { reader: h.domains.reader, state: h.store.getState(), viewportRows: 16, contentWidth: 76, boxInnerWidth: 72 }));
    assert.match(screen, /history unavailable/); assert.equal(screen.includes("No messages yet."), false);
});

test("X06 failed queued Comment renders its delivery error without dropping the body", async () => {
    const h = round6Tui(); h.domains.setContexts([context as never]);
    h.domains.messageHistory.patch({ context: { instance: "alpha", ctxId: "old", loading: false, entries: [{
        id: "failed", ctxId: "old", kind: "comment", createdAt: "2026-01-01T00:00:00Z", status: "failed", text: "User comment", error: "Context is disabled",
    }] } });
    h.store.setSelectedPage("messages"); h.store.pushRoute({ page: "messages", view: "thread", instance: "alpha", ctxId: "old" });
    const screen = await ink(createElement(TuiScreenRouter, { reader: h.domains.reader, state: h.store.getState(), viewportRows: 16, contentWidth: 76, boxInnerWidth: 72 }));
    assert.match(screen, /Context is disabled/); assert.match(screen, /User comment/);
});

import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { PassThrough } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { WriteStream } from "node:tty";
import { render } from "ink";
import { asInstanceName, type ApprovalRequest } from "@portable-devshell/shared";
import { buildFocusGraphForState, selectMainScreenModel, TuiAppStore, TuiCommandDispatcher, TuiFocusManager } from "../../src/testing.ts";
import { TuiOverlayView } from "../../src/view/overlay/View.tsx";
import { TuiTestDomains } from "../support/DomainHarness.ts";

function approval(instance: string, command: string): ApprovalRequest {
    return { approvalId: "same-approval", callId: "same-call", instance: asInstanceName(instance),
        ctxId: "old-context", toolName: "bash_run", inputSummary: command, reason: "Review operation",
        riskLevel: "high", source: "mcp", status: "pending",
        createdAt: "2026-10-20T00:00:00Z", expiresAt: "2099-01-01T00:00:00Z" };
}
function setup() {
    const domains = new TuiTestDomains(); const store = new TuiAppStore();
    domains.setInstances([{ name: "alpha", enabled: true, mcpEnabled: true }, { name: "beta", enabled: true, mcpEnabled: true }]);
    domains.setApprovals("alpha", [approval("alpha", "deploy-alpha")]);
    domains.setApprovals("beta", [approval("beta", "deploy-beta")]);
    store.setSelectedPage("audit"); store.setSelectedInstance("alpha");
    const model = () => selectMainScreenModel(store.getState(), domains.reader);
    const focusManager = new TuiFocusManager(store, {
        boxIdForLine: (id) => model().boxes.find((box) => box.expandedLines.some((line) => line.id === id))?.id,
        currentPage: () => store.getState().ui.selectedPage,
        expandedKeyFor: (id) => model().boxes.find((box) => box.id === id)?.expandedKey,
        graphFor: (page, mode) => buildFocusGraphForState({ ...store.getState(),
            interaction: { ...store.getState().interaction, focusScope: mode },
            ui: { ...store.getState().ui, selectedPage: page } }, domains.reader),
        mode: () => store.getState().interaction.focusScope,
    });
    const decisions: unknown[] = [];
    const dispatcher = new TuiCommandDispatcher({ store, focusManager, projection: domains.projection,
        mainViewportRows: () => 24, onApprovalDecision: async (...args) => { decisions.push(args); },
        onInstanceAction: async () => undefined, onOpenTerminal: async () => undefined,
        onPageReload: async () => undefined, onQuit: async () => undefined,
        onRedraw: () => undefined, onToolCall: async () => true,
    });
    return { domains, store, dispatcher, decisions };
}
async function renderOverlay(harness: ReturnType<typeof setup>) {
    const output = new PassThrough(); let captured = "";
    output.on("data", (chunk) => { captured += chunk.toString(); });
    const view = render(createElement(TuiOverlayView, { reader: harness.domains.reader,
        state: harness.store.getState(), viewportRows: 24, width: 100 }),
        { debug: true, stdout: output as unknown as WriteStream });
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup();
    return stripVTControlCharacters(captured);
}

test("round3: rendered TUI approval survives Context registry replacement and dispatches the reviewed instance identity", async () => {
    const harness = setup(); const { dispatcher, domains, store } = harness;
    await dispatcher.dispatch({ type: "approval.open", instance: "alpha", approvalId: "same-approval" });
    domains.setContexts([]);
    store.setSelectedInstance("beta");
    store.setFocusScope("approvalDetail");
    const text = await renderOverlay(harness);
    assert.match(text, /deploy-alpha/u); assert.doesNotMatch(text, /deploy-beta/u);
    store.replaceTopOverlay({ kind: "approval", instance: "alpha", approvalId: "same-approval", selectedAction: "approve" });
    await dispatcher.dispatch({ type: "focus.activate" });
    const confirmation = await renderOverlay(harness);
    assert.match(confirmation, /Confirm Approval/u); assert.match(confirmation, /on alpha/u);
    assert.deepEqual(harness.decisions, []);
    await dispatcher.dispatch({ type: "confirm.focus", button: "confirm" });
    await dispatcher.dispatch({ type: "confirm.accept" });
    assert.deepEqual(harness.decisions, [["alpha", "same-approval", "approve"]]);
});

test("round3: rendered TUI stale approval overlay cannot act on the matching id from another instance", async () => {
    const harness = setup(); const { dispatcher, domains, store } = harness;
    await dispatcher.dispatch({ type: "approval.open", instance: "alpha", approvalId: "same-approval" });
    domains.setApprovals("alpha", []);
    store.replaceTopOverlay({ kind: "approval", instance: "alpha", approvalId: "same-approval", selectedAction: "approve" });
    const text = await renderOverlay(harness);
    assert.match(text, /Approval is no longer pending/u); assert.doesNotMatch(text, /deploy-beta/u);
    await dispatcher.dispatch({ type: "focus.activate" });
    assert.deepEqual(harness.decisions, []);
    assert.equal(store.getState().interaction.overlays.length, 0);
});

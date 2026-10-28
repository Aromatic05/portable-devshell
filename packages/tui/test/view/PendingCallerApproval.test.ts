import { createElement } from "react";
import { PassThrough } from "node:stream";
import type { WriteStream } from "node:tty";
import { stripVTControlCharacters } from "node:util";
import { render } from "ink";
import { TuiOverlayView } from "../../src/view/overlay/View.tsx";
import assert from "node:assert/strict";
import test from "node:test";
import { round4Target, barrier } from "../../../core/test/unit/tool/Round4Harness.ts";
import { registerApprovalToolCallReview } from "../../../core/src/approval/execution/ToolCallReview.ts";
import { TuiKeyDispatcher } from "../../src/interaction/Input.ts";
import { round6Tui } from "../support/Round6Harness.ts";

for (const decision of ["approve", "deny"] as const) {
test(`caller Review full input is readable before ${decision} without ToolCall Audit`, async (t) => {
    const target = await round4Target({}, "alpha");
    t.after(() => target.close());
    const requested = barrier();
    registerApprovalToolCallReview(target.runtime.hooks, {
        async evaluate(input, signal) {
            const evaluation = await target.approval.evaluate(input, signal);
            requested.resolve();
            return evaluation;
        },
    });
    let executions = 0;
    target.runtime.hooks.registerExecute("local_effect", async () => { executions += 1; return {}; });
    const original = { command: "x".repeat(16000) + "TAIL-TUI-BEFORE-DECISION" };
    const call = target.runtime.api.call("alpha", "local_effect", original,
        { source: "extension", ctxId: "caller-context", workspace: target.directory },
        undefined, undefined, undefined, undefined, "caller");
    const completed = decision === "deny" ? assert.rejects(call, { code: "core.toolCallRejected" }) : call;
    await requested.promise;
    const approvals = await target.approval.listPendingApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0]!.recording, "caller");
    const h = round6Tui({
        mainContentColumns: () => 76, mainViewportRows: () => 9,
        onApprovalDecision: async (_instance, id, decision) => {
            await target.approval.decideApproval(id, { decision, decidedBy: "tui" });
        },
    });
    h.domains.setApprovals("alpha", approvals);
    h.domains.setToolCalls("alpha", []);
    h.store.setSelectedPage("audit");
    h.store.pushRoute({ page: "audit", view: "context", scope: "context", ctxId: "caller-context" });
    const box = h.model().boxes.find((entry) => entry.id === `approval-${approvals[0]!.approvalId}`);
    assert.ok(box);
    assert.equal(h.model().boxes.some((entry) => entry.id.startsWith("audit-call:")), false);
    h.store.setMainFocusId(box.id);
    h.store.toggleExpanded(box.expandedKey);
    const review = h.model().boxes.find((entry) => entry.id === box.id)!.expandedLines
        .find((line) => line.id?.includes(":approval.open:"));
    assert.ok(review?.id);
    h.store.setSelectedDetailLine(box.expandedKey, review.id);
    h.store.setFocusScope("mainBoxes");
    await h.dispatcher.dispatchMany(new TuiKeyDispatcher().dispatch("mainBoxes", { input: "", key: { return: true } }));
    const overlay = h.store.getState().interaction.overlays.at(-1);
    assert.equal(overlay?.kind, "approval");
    assert.ok(overlay?.kind === "approval");
    h.store.replaceTopOverlay({ ...overlay, selectedAction: "input" });
    await h.dispatcher.dispatch({ type: "focus.activate" });
    const detail = h.store.getState().interaction.overlays.at(-1);
    assert.ok(detail?.kind === "text-detail");
    assert.equal(detail.body, JSON.stringify(original));
    assert.match(detail.body, /TAIL-TUI-BEFORE-DECISION/);
    assert.equal(executions, 0);
    assert.equal((await target.approval.getApproval(approvals[0]!.approvalId)).status, "pending");
    assert.ok(approvals[0]!.inputSummary.length <= 512);
    await h.dispatcher.dispatchMany(new TuiKeyDispatcher().dispatch(h.store.getState().interaction.focusScope, { input: "", key: { end: true } }));
    const output = new PassThrough(); Object.assign(output, { columns: 76 });
    let text = "";
    output.on("data", (chunk) => { text += chunk.toString(); });
    const view = render(createElement(TuiOverlayView, { reader: h.domains.reader,
        state: h.store.getState(), viewportRows: 9, width: 76 }), {
        stdout: output as unknown as WriteStream, debug: true, patchConsole: false, exitOnCtrlC: false,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    view.cleanup(); output.destroy();
    assert.match(stripVTControlCharacters(text), /TAIL-TUI-BEFORE-DECISION/);

    await h.dispatcher.dispatch({ type: "textDetail.close" });
    h.store.replaceTopOverlay({ ...overlay, selectedAction: decision });
    await h.dispatcher.dispatch({ type: "focus.activate" });
    const confirmation = h.store.getState().interaction.overlays.at(-1);
    assert.ok(confirmation?.kind === "confirmation");
    assert.ok(confirmation.confirmIntent);
    await h.dispatcher.dispatch(confirmation.confirmIntent);
    await completed;
    assert.equal((await target.approval.getApproval(approvals[0]!.approvalId)).status, decision === "approve" ? "approved" : "denied");
    assert.equal(executions, decision === "approve" ? 1 : 0);
    assert.deepEqual(await target.history.read(), []);
});
}

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { asInstanceName, type ApprovalRequest } from "@portable-devshell/shared";
import { ApprovalActions } from "./Review.js";
import { approvalPeer } from "../../../../../../test/support/ApprovalPeer.js";

it("reloaded pending input exposes its full tail on demand before approval, while summary stays short", async () => {
    const originalInput = JSON.stringify({ command: "x".repeat(16000) + "\nTAIL-WEB-BEFORE-DECISION" });
    const request: ApprovalRequest = { approvalId: "review", callId: "not-executed",
        instance: asInstanceName("alpha"), ctxId: "ctx-a", workspace: "/project",
        inputSummary: originalInput.slice(0, 511) + "…", originalInput, toolName: "local_effect",
        reason: "Review", riskLevel: "high", source: "mcp", status: "pending",
        createdAt: new Date().toISOString(), expiresAt: "2099-01-01T00:00:00Z" };
    const peer = await approvalPeer(["alpha"]);
    try {
        await peer.put("alpha", [request]);
        peer.reset();
        const model = peer.models.get("alpha")!;
        await model.load();
        const pending = model.state.approvals[0]!;
        const review = vi.fn(() => { void model.decide("review", "approve"); });
        render(<><pre aria-label="Summary">{pending.inputSummary}</pre><ApprovalActions approval={pending}
            disabled={false} pending={false} onReview={review} /></>);
        expect(screen.queryByLabelText("Original approval input")).toBeNull();
        expect(screen.getByLabelText("Summary").textContent!.length).toBe(512);
        fireEvent.click(screen.getByRole("button", { name: "Show full input" }));
        expect(screen.getByLabelText("Original approval input").textContent).toBe(originalInput);
        expect(screen.getByLabelText("Original approval input").style.whiteSpace).toBe("pre-wrap");
        expect(screen.getByLabelText("Original approval input").style.overflowWrap).toBe("anywhere");
        expect(review).not.toHaveBeenCalled();
        expect(peer.decisions).toHaveLength(0);
        expect(model.state.approvals[0]!.status).toBe("pending");
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));
        await waitFor(() => expect(peer.decisions).toEqual([{ instance: "alpha", approvalId: "review", decision: "approve" }]));
        fireEvent.click(screen.getByRole("button", { name: "Hide full input" }));
        expect(screen.queryByLabelText("Original approval input")).toBeNull();
    } finally { peer.close(); }
});

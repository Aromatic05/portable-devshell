import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Audit } from "../../src/view/page/activity/audit/Page.js";
import { approvalOperationKey } from "../../src/state/Operation.js";
import { WebStore } from "../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "./DomainHarness.js";
import { auditCall, deferred, setupAudit } from "./BetaMatrixHarness.js";
import { round4Calls } from "./Round4Harness.js";

// Shared by the package regressions and the opt-in reproducer.
export function registerRound4WebDefects() {
    it("H-W1: failed approval must display the exact backend error after a reentrant store update", async () => {
        const { domains, store } = setupAudit(); const pending = deferred<void>();
        vi.spyOn(domains.approval("alpha"), "decide").mockReturnValue(pending.promise);
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));
        fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
        await waitFor(() => expect(store.state.operations[approvalOperationKey("alpha", "approval-alpha")]).toBe("pending"));
        await act(async () => pending.reject(new Error("Policy service refused approval-alpha at revision 42")));
        expect(store.state.error).toBe("Policy service refused approval-alpha at revision 42");
        expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(store.state.error!);
    });

    it("H-W2: authoritative stream shrink on page 3 must leave durable audit rows reachable", () => {
        const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }]);
        domains.setToolCalls("alpha", round4Calls(45));
        render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "all" } }} />));
        fireEvent.click(screen.getByRole("button", { name: "Next page" }));
        fireEvent.click(screen.getByRole("button", { name: "Next page" }));
        act(() => domains.setToolCalls("alpha", round4Calls(5)));
        expect(screen.getByText("operation_004")).toBeInTheDocument();
        expect(screen.queryByText("No tool calls match these filters.")).not.toBeInTheDocument();
    });

    it("H-W3: late Audit detail read must not regress a newer authoritative completion", async () => {
        const domains = new WebTestDomains(); domains.setInstances([{ name: "alpha" }]);
        const compact = { ...auditCall, input: undefined, output: undefined };
        domains.setToolCalls("alpha", [compact]);
        const pending = deferred<typeof auditCall>();
        const readDetail = vi.spyOn(domains.toolCalls, "readDetail").mockImplementation(async () => [await pending.promise]);
        render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "instance", instance: "alpha" } }} />));
        fireEvent.click(screen.getByText("bash_run"));
        await waitFor(() => expect(readDetail).toHaveBeenCalledOnce());
        act(() => domains.setToolCalls("alpha", [{ ...compact, status: "completed", completedAt: "2026-10-20T01:01:00Z" }]));
        await act(async () => pending.resolve(auditCall));
        expect(within(screen.getByText("bash_run").closest("summary")!).getByText("completed")).toBeInTheDocument();
        expect(screen.getByText("Completed").nextElementSibling).toHaveTextContent("2026-10-20T01:01:00Z");
    });


    it("H-W4: alpha pending approval must not block beta with the same instance-local approval id", async () => {
        const { domains, store, unmount } = setupAudit(); unmount();
        const alpha = domains.approval("alpha").state.approvals[0];
        domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
        domains.setApprovals("beta", [{ ...alpha, instance: "beta" }]);
        domains.setToolCalls("beta", [{ ...auditCall, instance: "beta" }]);
        const pending = deferred<void>(); const entered = deferred<void>();
        vi.spyOn(domains.approval("alpha"), "decide").mockImplementation(async () => { entered.resolve(); await pending.promise; });
        const decideBeta = vi.spyOn(domains.approval("beta"), "decide");
        const alphaDecision = store.decideTool("alpha", alpha.approvalId, "approve"); await entered.promise;
        render(withWebDomains(domains, <Audit store={store} navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "instance", instance: "beta" } }} />));
        fireEvent.click(screen.getByRole("button", { name: "Approve" }));
        await act(async () => { fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" })); });
        pending.resolve(); await act(async () => { await alphaDecision; });
        expect(decideBeta).toHaveBeenCalledExactlyOnceWith(alpha.approvalId, "approve");
    });

}

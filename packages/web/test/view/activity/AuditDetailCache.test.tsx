import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ToolCallEntry } from "../../../src/view/page/activity/audit/tool/Entry.js";
import { auditCall, deferred } from "../../support/BetaMatrixHarness.js";

it("retains completed detail through ten equivalent preview replacements, but refreshes genuine changes", async () => {
    const preview = { ...auditCall, status: "completed" as const,
        completedAt: "2026-10-20T01:05:00Z", input: undefined, output: undefined };
    const onLoadDetail = vi.fn().mockResolvedValue({ ...preview, input: { command: "CACHED-DETAIL" } });
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    const view = (call = preview) => <ToolCallEntry call={call} initiallyOpen logs={[]}
        onLoadDetail={onLoadDetail} onRefresh={onRefresh} onReviewApproval={() => undefined}
        onLoadImage={vi.fn()} />;
    const mounted = render(view());
    expect(await screen.findByText(/CACHED-DETAIL/u)).toBeInTheDocument();
    for (let i = 0; i < 10; i++) {
        await act(async () => mounted.rerender(view({ ...preview })));
        expect(screen.getByText(/CACHED-DETAIL/u)).toBeInTheDocument();
        expect(screen.queryByText("Loading details…")).not.toBeInTheDocument();
    }
    expect(onLoadDetail).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/CACHED-DETAIL/u)).toBeInTheDocument();
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onLoadDetail).toHaveBeenCalledTimes(2);
    await act(async () => mounted.rerender(view({ ...preview, completedAt: "2026-10-20T01:06:00Z" })));
    expect(onLoadDetail).toHaveBeenCalledTimes(3);
});

it("does not cancel an in-flight detail read for an equivalent preview replacement", async () => {
    const preview = { ...auditCall, input: undefined, output: undefined };
    const pending = deferred<typeof auditCall>();
    const onLoadDetail = vi.fn().mockReturnValue(pending.promise);
    const view = () => <ToolCallEntry call={{ ...preview }} initiallyOpen logs={[]}
        onLoadDetail={onLoadDetail} onRefresh={vi.fn()} onReviewApproval={() => undefined}
        onLoadImage={vi.fn()} />;
    const mounted = render(view());
    mounted.rerender(view());
    await act(async () => pending.resolve({ ...auditCall, input: { command: "INFLIGHT-DETAIL" } }));
    expect(screen.getByText(/INFLIGHT-DETAIL/u)).toBeInTheDocument();
    expect(onLoadDetail).toHaveBeenCalledTimes(1);
});

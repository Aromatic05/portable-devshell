import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import { WebStore } from "../../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";
import { auditCall } from "../../support/BetaMatrixHarness.js";

it("keeps Audit current while visible without repeatedly pulling every Web domain", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        domains.setToolCalls("alpha", [auditCall]);
        const refreshed = { ...auditCall, callId: "new-call", toolName: "file_read" };
        const refresh = vi.fn(async (instance: string) => {
            domains.setToolCalls(instance, [auditCall, refreshed]);
        });
        Object.assign(domains.toolCalls, { refresh });
        const store = new WebStore(domains.domains);
        const fullRefresh = vi.spyOn(store, "refreshAudit");
        const view = render(withWebDomains(domains, <Audit
            store={store}
            navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "all" } }}
        />));

        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(refresh).toHaveBeenCalledExactlyOnceWith("alpha", expect.any(AbortSignal));
        expect(screen.getByText("file_read", { selector: "strong" })).toBeInTheDocument();
        expect(fullRefresh).not.toHaveBeenCalled();

        visibility.mockReturnValue("hidden");
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(refresh).toHaveBeenCalledTimes(1);

        visibility.mockReturnValue("visible");
        await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
        expect(refresh).toHaveBeenCalledTimes(2);

        view.unmount();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(refresh).toHaveBeenCalledTimes(2);
    } finally {
        visibility.mockRestore();
        vi.useRealTimers();
    }
});

it("does not pile up Audit reads while a previous refresh is pending", async () => {
    vi.useFakeTimers();
    try {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        let finish!: () => void;
        const first = new Promise<void>((resolve) => { finish = resolve; });
        const refresh = vi.fn().mockReturnValueOnce(first).mockResolvedValue(undefined);
        Object.assign(domains.toolCalls, { refresh });
        const view = render(withWebDomains(domains, <Audit
            store={new WebStore(domains.domains)}
            navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "all" } }}
        />));

        await act(async () => { await vi.advanceTimersByTimeAsync(90_000); });
        expect(refresh).toHaveBeenCalledTimes(1);
        await act(async () => { finish(); });
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
        expect(refresh).toHaveBeenCalledTimes(2);
        view.unmount();
    } finally {
        vi.useRealTimers();
    }
});

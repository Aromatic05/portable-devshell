import { act, render } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import { WebStore } from "../../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";

it("keeps the Audit timer running through frequent Instance snapshot publications", async () => {
    vi.useFakeTimers();
    try {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        const refresh = vi.fn().mockResolvedValue(undefined);
        Object.assign(domains.toolCalls, { refresh });
        const view = render(withWebDomains(domains, <Audit
            store={new WebStore(domains.domains)}
            navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "all" } }}
        />));
        for (let i = 0; i < 12; i++) {
            await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
            await act(async () => { domains.setInstances([{ name: "alpha" }]); });
        }
        expect(refresh).toHaveBeenCalledTimes(4);
        view.unmount();
    } finally { vi.useRealTimers(); }
});

it("keeps polling healthy Instances and retries a timed-out sibling", async () => {
    vi.useFakeTimers();
    try {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
        const refresh = vi.fn((instance: string) => instance === "alpha"
            ? new Promise<void>(() => undefined)
            : Promise.resolve());
        Object.assign(domains.toolCalls, { refresh });
        const view = render(withWebDomains(domains, <Audit
            store={new WebStore(domains.domains)}
            navigate={() => undefined}
            route={{ page: "audit", view: "timeline", scope: { kind: "all" } }}
        />));
        await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
        expect(refresh.mock.calls.filter(([instance]) => instance === "alpha")).toHaveLength(2);
        expect(refresh.mock.calls.filter(([instance]) => instance === "beta")).toHaveLength(4);
        view.unmount();
    } finally { vi.useRealTimers(); }
});

it("expires a hung whole-Audit refresh and permits the next read", async () => {
    vi.useFakeTimers();
    try {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        const load = vi.fn().mockReturnValueOnce(new Promise<void>(() => undefined))
            .mockResolvedValue(undefined);
        Object.assign(domains.toolCalls, { load });
        const store = new WebStore(domains.domains, { requestTimeoutMs: 1_000 });
        const first = store.refreshAudit();
        await vi.advanceTimersByTimeAsync(1_000);
        await first;
        expect(store.state.error).toMatch(/Audit refresh timed out/);
        await store.refreshAudit();
        expect(load).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
});

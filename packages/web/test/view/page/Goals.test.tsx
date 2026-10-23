import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Goals } from "../../../src/view/page/Goals.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";

describe("Goals page", () => {
    it("shows the source failure instead of claiming there are no Goals", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        Object.assign(domains.goals, { load: async () => undefined });
        domains.goals.set({ instances: {
            alpha: { goals: [], failure: new Error("goal read failed"), lastSeq: 0, status: "reconnecting" },
        } } as never);
        render(withWebDomains(domains, <Goals />));
        expect(await screen.findByText(/goal read failed/u)).toBeInTheDocument();
        expect(screen.queryByText("No active Workspace Goals.")).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Retry alpha" })).toBeInTheDocument();
    });
    it("displays the current final Goal without Todo steps", async () => {
        const domains = new WebTestDomains();
        domains.setInstances([{ name: "alpha" }]);
        Object.assign(domains.goals, { load: async () => undefined });
        domains.goals.set({ instances: { alpha: { goals: [{
            goalId: "goal-1", objective: "Ship beta", status: "active", revision: 2,
            note: "Progress lives in Memory", workspace: "/project/alpha",
        }], lastSeq: 1, status: "ready" } }, status: "ready" } as never);
        render(withWebDomains(domains, <Goals />));
        expect(await screen.findByText("Ship beta")).toBeInTheDocument();
        expect(screen.getByText("Ship beta").closest("article")).toHaveTextContent("revision 2");
        expect(screen.getByText("Progress lives in Memory")).toBeInTheDocument();
    });
});

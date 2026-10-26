import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { WebPageSnapshot } from "@portable-devshell/shared";
import { expect, it, vi } from "vitest";

import { ExtensionPage } from "../../../src/view/page/Extension.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";
import { deferred } from "../../support/BetaMatrixHarness.js";

function snapshot(text: string): WebPageSnapshot {
    return { tables: [{ id: "items", columns: [{ id: "name", label: "Name" }],
        rows: [{ id: "item", cells: { name: { text } },
            actions: [{ id: "delete", label: "Delete", tone: "danger" }] }] }] };
}

it.each(["success", "failure"] as const)("ignores stale extension action %s after switching pages", async (outcome) => {
    const domains = new WebTestDomains();
    const request = deferred<WebPageSnapshot>();
    const betaRequest = deferred<WebPageSnapshot>();
    Object.assign(domains.extension, {
        readWebPage: vi.fn(async (id: string) => snapshot(id)),
        webAction: vi.fn().mockReturnValueOnce(request.promise).mockReturnValueOnce(betaRequest.promise),
    });
    const view = (id: string) => withWebDomains(domains,
        <ExtensionPage descriptor={{ id, extensionId: id, title: id }} />);
    const mounted = render(view("alpha"));
    await screen.findByRole("cell", { name: "alpha" });
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    mounted.rerender(view("beta"));
    await screen.findByRole("cell", { name: "beta" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Delete" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    const completions = {
        success: () => request.resolve(snapshot("obsolete alpha result")),
        failure: () => request.reject(new Error("obsolete alpha failure")),
    };
    await act(async () => completions[outcome]());
    expect(screen.getByRole("cell", { name: "beta" })).toBeInTheDocument();
    expect(screen.queryByText(/obsolete alpha/u)).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await act(async () => betaRequest.resolve(snapshot("beta action result")));
    expect(screen.getByRole("cell", { name: "beta action result" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("shows a failed confirmation inside the extension dialog and allows retry", async () => {
    const domains = new WebTestDomains();
    const webAction = vi.fn().mockRejectedValueOnce(new Error("Delete denied"))
        .mockResolvedValueOnce(snapshot("deleted"));
    Object.assign(domains.extension, { readWebPage: async () => snapshot("alpha"), webAction });
    render(withWebDomains(domains,
        <ExtensionPage descriptor={{ id: "alpha", extensionId: "alpha", title: "Alpha" }} />));
    fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Delete denied");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await screen.findByRole("cell", { name: "deleted" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(webAction).toHaveBeenCalledTimes(2);
});

it("ignores an old extension read after switching pages", async () => {
    const domains = new WebTestDomains();
    const request = deferred<WebPageSnapshot>();
    const readWebPage = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValueOnce(snapshot("beta"));
    Object.assign(domains.extension, { readWebPage });
    const view = (id: string) => withWebDomains(domains,
        <ExtensionPage descriptor={{ id, extensionId: id, title: id }} />);
    const mounted = render(view("alpha"));
    mounted.rerender(view("beta"));
    await screen.findByRole("cell", { name: "beta" });
    await act(async () => request.resolve(snapshot("obsolete alpha")));
    expect(screen.getByRole("cell", { name: "beta" })).toBeInTheDocument();
    expect(screen.queryByText("obsolete alpha")).not.toBeInTheDocument();
});

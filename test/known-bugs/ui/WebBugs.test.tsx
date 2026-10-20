import React from "../../../packages/web/node_modules/react/index.js";
import { act, fireEvent, render, screen, waitFor, within } from "../../../packages/web/node_modules/@testing-library/react/dist/index.js";
import { expect, it, vi } from "../../../packages/web/node_modules/vitest/dist/index.js";
import { Instances } from "../../../packages/web/src/view/page/Instances.js";
import { withWebDomains } from "../../../packages/web/test/support/DomainHarness.js";
import { deferred, setupAudit, setupConfig, configView } from "../../../packages/web/test/support/BetaMatrixHarness.js";

function restartChange() {
    fireEvent.change(screen.getByRole("spinbutton", { name: "Log retention days" }), { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & Restart" }));
}

it("round3: failed persistence after stop restarts the original worker exactly once", async () => {
    const { domains } = setupConfig();
    const sequence: string[] = [];
    vi.spyOn(domains.runtime("alpha"), "stop").mockImplementation(async () => { sequence.push("stop"); });
    const update = vi.spyOn(domains.config, "update").mockImplementation(async () => {
        sequence.push("update"); throw new Error("Disk is read only");
    });
    vi.spyOn(domains.runtime("alpha"), "start").mockImplementation(async () => { sequence.push("start"); });
    restartChange();
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk is read only");
    expect(sequence).toEqual(["stop", "update", "start"]);
    expect(update).toHaveBeenCalledOnce();
    expect(screen.queryByText("Configuration saved and worker restarted.")).not.toBeInTheDocument();
});

it("round3: rejected Audit approval preserves review context and permits an explicit retry", async () => {
    const { domains } = setupAudit();
    const decide = vi.spyOn(domains.approval("alpha"), "decide")
        .mockRejectedValueOnce(new Error("Approval conflict"))
        .mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("Approval conflict");
    expect(dialog).toHaveTextContent("Review deploy");
    fireEvent.click(within(dialog).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide.mock.calls).toEqual([["approval-alpha", "deny"], ["approval-alpha", "deny"]]);
});

it("unsaved configuration survives an unrelated server revision", () => {
    const { domains, store, unmount } = setupConfig();
    unmount();
    render(withWebDomains(domains, <Instances navigate={() => undefined} route={{ page: "instances", instance: "alpha", view: "config" }} store={store} />));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Log retention days" }), { target: { value: "30" } });
    const next = configView();
    next.instances[0]!.workspace.enabled = false;
    act(() => domains.setConfig(next));
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(30);
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
});

it("in-flight config update makes the rendered Save button unavailable", async () => {
    const { domains, store, unmount } = setupConfig();
    unmount();
    render(withWebDomains(domains, <Instances navigate={() => undefined} route={{ page: "instances", instance: "alpha", view: "config" }} store={store} />));
    const pending = deferred<unknown>();
    vi.spyOn(domains.config, "update").mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace enabled" }));
    let operation!: Promise<boolean>;
    act(() => { operation = store.updateConfig({ instance: { instanceName: "alpha", patch: { enabled: false } } }); });
    expect(store.state.operations["config:update"]).toBe("pending");
    const save = screen.getByRole("button", { name: "Save Only" });
    // Settle the request before asserting so failures leave no active timers.
    const wasDisabled = (save as HTMLButtonElement).disabled;
    await act(async () => { pending.resolve({}); await operation; });
    expect(wasDisabled).toBe(true);
});

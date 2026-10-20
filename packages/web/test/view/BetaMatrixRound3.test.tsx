import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Instances } from "../../src/view/page/Instances.js";
import { withWebDomains } from "../support/DomainHarness.js";
import { deferred, setupAudit, setupConfig, setupTodos, todo } from "../support/BetaMatrixHarness.js";

function restartChange() {
    fireEvent.change(screen.getByRole("spinbutton", { name: "Log retention days" }),
        { target: { value: "30" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & Restart" }));
}

it("round3: validation failure stops the restart chain before touching the worker", async () => {
    const { domains } = setupConfig();
    const validate = vi.spyOn(domains.config, "validate").mockRejectedValue(new Error("Invalid retention policy"));
    const stop = vi.spyOn(domains.runtime("alpha"), "stop");
    const update = vi.spyOn(domains.config, "update");
    const start = vi.spyOn(domains.runtime("alpha"), "start");
    restartChange();
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid retention policy");
    expect(validate).toHaveBeenCalledOnce();
    expect(stop).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(30);
});

it("round3: failed worker stop prevents both persistence and a spurious start", async () => {
    const { domains } = setupConfig();
    vi.spyOn(domains.runtime("alpha"), "stop").mockRejectedValue(new Error("Worker stop refused"));
    const update = vi.spyOn(domains.config, "update");
    const start = vi.spyOn(domains.runtime("alpha"), "start");
    restartChange();
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker stop refused");
    expect(update).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
});



it("round3: restart failure after persistence reports the failure without claiming success", async () => {
    const { domains } = setupConfig();
    const update = vi.spyOn(domains.config, "update");
    vi.spyOn(domains.runtime("alpha"), "start").mockRejectedValue(new Error("Worker startup failed"));
    restartChange();
    expect(await screen.findByRole("alert")).toHaveTextContent("Worker startup failed");
    expect(update).toHaveBeenCalledOnce();
    expect(screen.queryByText("Configuration saved and worker restarted.")).not.toBeInTheDocument();
});

it("round3: a Todo replacement cannot retarget an already reviewed delete confirmation", async () => {
    const { domains } = setupTodos();
    const removeAlpha = vi.spyOn(domains.todo("alpha"), "delete");
    const removeBeta = vi.spyOn(domains.todo("beta"), "delete");
    fireEvent.click(within(screen.getByText("Alpha project").closest("article")!).getByRole("button", { name: "Delete project" }));
    act(() => domains.setTodo("alpha", todo("replacement-task", 1, "Replacement project")));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveTextContent("Alpha project (same-task)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(removeAlpha).toHaveBeenCalledExactlyOnceWith("same-task"));
    expect(removeBeta).not.toHaveBeenCalled();
    expect(screen.getByText("Replacement project")).toBeInTheDocument();
});

it("round3: disconnect while Todo confirmation is open blocks mutation and reconnect restores the same target", async () => {
    const { domains } = setupTodos();
    const remove = vi.spyOn(domains.todo("beta"), "delete");
    fireEvent.click(within(screen.getByText("Beta project").closest("article")!).getByRole("button", { name: "Delete project" }));
    act(() => domains.server.patch({ status: "offline" }));
    const confirm = within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" });
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(remove).not.toHaveBeenCalled();
    act(() => domains.server.patch({ status: "online" }));
    fireEvent.click(confirm);
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("same-task"));
});

it("round3: pending Todo delete blocks repeated clicks, Escape and backdrop cancellation", async () => {
    const { domains } = setupTodos();
    const pending = deferred<void>();
    const remove = vi.spyOn(domains.todo("alpha"), "delete").mockReturnValue(pending.promise);
    fireEvent.click(within(screen.getByText("Alpha project").closest("article")!).getByRole("button", { name: "Delete project" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Deleting…" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    fireEvent.mouseDown(dialog.parentElement!);
    expect(dialog).toHaveAttribute("aria-busy", "true");
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await act(async () => pending.resolve());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("round3: Audit approval remains actionable without a Context registry entry and serializes the pending decision", async () => {
    const { domains } = setupAudit();
    const pending = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValue(pending.promise);
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(approve).toBeEnabled();
    fireEvent.click(approve);
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Approve" });
    expect(confirm).toHaveFocus();
    fireEvent.click(confirm);
    expect(approve).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Approving…" }));
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(decide).toHaveBeenCalledExactlyOnceWith("approval-alpha", "approve"));
    expect(dialog).toHaveAttribute("aria-busy", "true");
    await act(async () => pending.resolve());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});



it("round3: removing a pending approval while its confirmation is open removes the obsolete action", () => {
    const { domains } = setupAudit();
    const decide = vi.spyOn(domains.approval("alpha"), "decide");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    act(() => domains.setApprovals("alpha", []));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    expect(decide).not.toHaveBeenCalled();
});


it("round3: real Instances navigation remounts Config and contains a late save from the previous instance", async () => {
    const { domains, store, unmount } = setupConfig();
    unmount();
    const pending = deferred<unknown>();
    const update = vi.spyOn(domains.config, "update").mockReturnValue(pending.promise);
    const view = (instance: string) => withWebDomains(domains,
        <Instances navigate={() => undefined} route={{ page: "instances", instance, view: "config" }} store={store} />);
    const mounted = render(view("alpha"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Only" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    mounted.rerender(view("beta"));
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(14);
    await act(async () => pending.resolve({}));
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(14);
    const draft = JSON.parse((screen.getByRole("textbox", { name: "Advanced instance JSON" }) as HTMLTextAreaElement).value);
    expect(draft.name).toBe("beta");
    expect(update).toHaveBeenCalledOnce();
});

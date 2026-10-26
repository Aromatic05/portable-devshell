import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { configView, deferred, setupConfig } from "../../support/BetaMatrixHarness.js";

const retention = () => screen.getByRole("spinbutton", { name: "Log retention days" });
const workspace = () => screen.getByRole("checkbox", { name: "Workspace enabled" });
const saveRestart = () => screen.getByRole("button", { name: "Save & Restart" });
function editRetention() { fireEvent.change(retention(), { target: { value: "30" } }); }

it("keeps dirty and invalid drafts through server revisions; Cancel adopts the latest server state", () => {
    const { domains } = setupConfig();
    editRetention();
    const revision = configView();
    revision.instances[0]!.logs.retentionDays = 21;
    revision.instances[0]!.workspace.enabled = false;
    act(() => domains.setConfig(revision));
    expect(retention()).toHaveValue(30);
    expect(workspace()).toBeChecked();
    const json = screen.getByRole("textbox", { name: "Advanced instance JSON" });
    fireEvent.change(json, { target: { value: '{"unfinished":' } });
    act(() => domains.setConfig(configView()));
    expect(json).toHaveValue('{"unfinished":');
    expect(saveRestart()).toBeDisabled();
    act(() => domains.setConfig(revision));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(retention()).toHaveValue(21);
    expect(workspace()).not.toBeChecked();
    expect(screen.getByText("Saved")).toBeInTheDocument();
});

it("a clean editor follows authoritative server revisions", () => {
    const { domains } = setupConfig();
    const revision = configView(); revision.instances[0]!.logs.retentionDays = 19;
    act(() => domains.setConfig(revision));
    expect(retention()).toHaveValue(19);
    expect(saveRestart()).toBeDisabled();
});

it("holds save controls through validation, stop, persistence and recovery, preserving the disk failure", async () => {
    const { domains } = setupConfig();
    const validation = deferred<void>(), stopping = deferred<void>(), updating = deferred<unknown>(), starting = deferred<void>();
    const validate = vi.spyOn(domains.config, "validate").mockReturnValue(validation.promise);
    const stop = vi.spyOn(domains.runtime("alpha"), "stop").mockReturnValue(stopping.promise);
    const update = vi.spyOn(domains.config, "update").mockReturnValue(updating.promise);
    const start = vi.spyOn(domains.runtime("alpha"), "start").mockReturnValue(starting.promise);
    editRetention(); fireEvent.click(saveRestart()); fireEvent.click(saveRestart());
    expect(saveRestart()).toBeDisabled();
    expect(retention()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Reload" })).toBeDisabled();
    expect(screen.getByText("Working…")).toBeInTheDocument();
    expect(validate).toHaveBeenCalledOnce(); expect(stop).not.toHaveBeenCalled();
    await act(async () => validation.resolve());
    expect(stop).toHaveBeenCalledOnce(); expect(update).not.toHaveBeenCalled(); expect(saveRestart()).toBeDisabled();
    await act(async () => stopping.resolve());
    expect(update).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled(); expect(saveRestart()).toBeDisabled();
    await act(async () => updating.reject(new Error("ENOSPC: revision 8 could not be persisted")));
    expect(start).toHaveBeenCalledOnce(); expect(saveRestart()).toBeDisabled();
    await act(async () => starting.resolve());
    expect(screen.getByRole("alert")).toHaveTextContent("ENOSPC: revision 8 could not be persisted");
    expect(retention()).toHaveValue(30); expect(saveRestart()).toBeEnabled();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
});

it("preserves persistence and recovery failures, then retries Start without repersisting", async () => {
    const { domains } = setupConfig();
    const update = vi.spyOn(domains.config, "update").mockRejectedValue(new Error("Disk read only"));
    const start = vi.spyOn(domains.runtime("alpha"), "start")
        .mockRejectedValueOnce(new Error("Worker cannot bind port 42")).mockResolvedValueOnce(undefined);
    editRetention(); fireEvent.click(saveRestart());
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk read only");
    expect(screen.getByRole("alert")).toHaveTextContent("Worker cannot bind port 42");
    fireEvent.click(screen.getByRole("button", { name: "Retry Start" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry Start" })).not.toBeInTheDocument());
    expect(update).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledTimes(2);
    expect(retention()).toHaveValue(30); expect(saveRestart()).toBeEnabled();
});

it("a committed save with failed startup becomes clean and supports failed and successful Start retries", async () => {
    const { domains } = setupConfig();
    const update = vi.spyOn(domains.config, "update").mockImplementation(async () => {
        const revision = configView(); revision.instances[0]!.logs.retentionDays = 30;
        domains.setConfig(revision); return {};
    });
    const stop = vi.spyOn(domains.runtime("alpha"), "stop");
    const start = vi.spyOn(domains.runtime("alpha"), "start")
        .mockRejectedValueOnce(new Error("Startup fault A"))
        .mockRejectedValueOnce(new Error("Startup fault B")).mockResolvedValueOnce(undefined);
    editRetention(); fireEvent.click(saveRestart());
    expect(await screen.findByRole("alert")).toHaveTextContent("Startup fault A");
    expect(retention()).toHaveValue(30); expect(screen.getByText("Saved")).toBeInTheDocument(); expect(saveRestart()).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry Start" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Startup fault B"));
    expect(screen.getByRole("button", { name: "Retry Start" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Retry Start" }));
    await waitFor(() => expect(screen.getByText("Worker restarted.")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(update).toHaveBeenCalledOnce(); expect(stop).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledTimes(3);
});

it("validation and Stop failures preserve the draft and explicit retries report the current failure", async () => {
    const { domains } = setupConfig();
    const validate = vi.spyOn(domains.config, "validate").mockRejectedValueOnce(new Error("Retention validation fault")).mockResolvedValue(undefined);
    const stop = vi.spyOn(domains.runtime("alpha"), "stop").mockRejectedValueOnce(new Error("Stop refused revision 10")).mockResolvedValueOnce(undefined);
    const update = vi.spyOn(domains.config, "update"), start = vi.spyOn(domains.runtime("alpha"), "start");
    editRetention(); fireEvent.click(saveRestart());
    expect(await screen.findByRole("alert")).toHaveTextContent("Retention validation fault"); expect(stop).not.toHaveBeenCalled();
    fireEvent.click(saveRestart());
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Stop refused revision 10"));
    expect(update).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(retention()).toHaveValue(30);
    fireEvent.click(saveRestart());
    await waitFor(() => expect(screen.getByText("Configuration saved and worker restarted.")).toBeInTheDocument());
    expect(validate).toHaveBeenCalledTimes(3); expect(update).toHaveBeenCalledOnce(); expect(start).toHaveBeenCalledOnce();
});

it("late validation after direct instance selection cannot stop or save the old instance", async () => {
    const { domains, view, rerender } = setupConfig();
    const validation = deferred<void>(); vi.spyOn(domains.config, "validate").mockReturnValue(validation.promise);
    const stop = vi.spyOn(domains.runtime("alpha"), "stop"), update = vi.spyOn(domains.config, "update");
    editRetention(); fireEvent.click(saveRestart()); rerender(view("beta"));
    await act(async () => validation.resolve());
    expect(retention()).toHaveValue(14); expect(workspace()).toBeEnabled();
    expect(stop).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
    expect(screen.queryByText("Configuration is valid.")).not.toBeInTheDocument();
});

it("late save failure on a reused Config cannot overwrite the new instance's draft or feedback", async () => {
    const { domains, view, rerender } = setupConfig();
    const pending = deferred<unknown>(); const update = vi.spyOn(domains.config, "update").mockReturnValue(pending.promise);
    fireEvent.click(workspace()); fireEvent.click(screen.getByRole("button", { name: "Save Only" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce()); rerender(view("beta"));
    await act(async () => pending.reject(new Error("Alpha disk offline")));
    expect(retention()).toHaveValue(14); expect(workspace()).toBeEnabled(); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("Reload failure keeps the draft, retry adopts the server, and late reload cannot retarget", async () => {
    const { domains, view, rerender } = setupConfig();
    const stale = deferred<void>();
    const refresh = vi.spyOn(domains.config, "refresh").mockRejectedValueOnce(new Error("Control revision unavailable"))
        .mockImplementationOnce(async () => {
            const revision = configView(); revision.instances[0]!.logs.retentionDays = 23; domains.setConfig(revision);
        }).mockReturnValueOnce(stale.promise);
    editRetention(); fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Control revision unavailable"); expect(retention()).toHaveValue(30);
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(retention()).toHaveValue(23));
    fireEvent.click(screen.getByRole("button", { name: "Reload" })); rerender(view("beta"));
    fireEvent.change(retention(), { target: { value: "33" } });
    await act(async () => stale.resolve());
    expect(retention()).toHaveValue(33); expect(screen.queryByText("Reloaded from Control.")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(3);
});

it("detached save restores the original stopped worker after disk rejection without changing a replacement draft", async () => {
    const { domains, view, rerender } = setupConfig();
    const stopping = deferred<void>();
    const stop = vi.spyOn(domains.runtime("alpha"), "stop").mockReturnValue(stopping.promise);
    const update = vi.spyOn(domains.config, "update").mockRejectedValue(new Error("Original disk offline"));
    const startAlpha = vi.spyOn(domains.runtime("alpha"), "start"), startBeta = vi.spyOn(domains.runtime("beta"), "start");
    editRetention(); fireEvent.click(saveRestart());
    await waitFor(() => expect(stop).toHaveBeenCalledOnce());
    rerender(view("beta")); fireEvent.change(retention(), { target: { value: "33" } });
    await act(async () => stopping.resolve());
    expect(update).toHaveBeenCalledOnce(); expect(startAlpha).toHaveBeenCalledOnce(); expect(startBeta).not.toHaveBeenCalled();
    expect(retention()).toHaveValue(33); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(saveRestart()).toBeEnabled();
});

it("retrying a failed disk save persists once more and clears obsolete recovery controls", async () => {
    const { domains } = setupConfig();
    const update = vi.spyOn(domains.config, "update").mockRejectedValueOnce(new Error("Disk fault"))
        .mockImplementationOnce(async () => {
            const revision = configView(); revision.instances[0]!.logs.retentionDays = 30;
            domains.setConfig(revision); return {};
        });
    const start = vi.spyOn(domains.runtime("alpha"), "start").mockRejectedValueOnce(new Error("Recovery fault")).mockResolvedValueOnce(undefined);
    editRetention(); fireEvent.click(saveRestart());
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk fault");
    expect(screen.getByRole("button", { name: "Retry Start" })).toBeEnabled();
    fireEvent.click(saveRestart());
    await waitFor(() => expect(screen.getByText("Configuration saved and worker restarted.")).toBeInTheDocument());
    expect(update).toHaveBeenCalledTimes(2); expect(start).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Retry Start" })).not.toBeInTheDocument();
    expect(saveRestart()).toBeDisabled(); expect(retention()).toHaveValue(30);
});

it("subscribes to an external config operation and unlocks its dirty controls after rejection", async () => {
    const { domains, store } = setupConfig();
    const pending = deferred<unknown>(); vi.spyOn(domains.config, "update").mockReturnValue(pending.promise);
    fireEvent.click(workspace());
    let operation!: Promise<boolean>;
    act(() => { operation = store.updateConfig({ instance: { instanceName: "beta", patch: { enabled: false } } }); });
    expect(screen.getByRole("button", { name: "Save Only" })).toBeDisabled();
    expect(workspace()).toBeDisabled(); expect(screen.getByText("Working…")).toBeInTheDocument();
    await act(async () => { pending.reject(new Error("External config write conflict")); expect(await operation).toBe(false); });
    expect(store.operationFailure("config:update")).toBe("External config write conflict");
    expect(screen.getByRole("button", { name: "Save Only" })).toBeEnabled(); expect(workspace()).not.toBeChecked();
    expect(screen.getByText("Unsaved changes")).toBeInTheDocument();
});

it("reconnect cancels validation with its real reason; retry succeeds and the detached rejection cannot regress it", async () => {
    const { domains, store } = setupConfig();
    const old = deferred<void>();
    const validate = vi.spyOn(domains.config, "validate").mockReturnValueOnce(old.promise).mockResolvedValueOnce(undefined);
    editRetention(); fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(screen.getByRole("button", { name: "Validate" })).toBeDisabled();
    await act(async () => store.reconnect());
    expect(screen.getByRole("alert")).toHaveTextContent("Web connection is reconnecting.");
    expect(retention()).toHaveValue(30); expect(saveRestart()).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() => expect(screen.getByText("Configuration is valid.")).toBeInTheDocument());
    await act(async () => old.reject(new Error("Detached validation failed")));
    expect(validate).toHaveBeenCalledTimes(2); expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Configuration is valid.")).toBeInTheDocument(); expect(store.state.error).toBeUndefined();
    expect(retention()).toHaveValue(30);
});

it("keeps the trailing comma while typing model extensions and persists both entries", async () => {
    const { domains } = setupConfig();
    const update = vi.spyOn(domains.config, "update");
    const extensions = screen.getByRole("textbox", { name: "Model extensions" });
    fireEvent.change(extensions, { target: { value: "instance," } });
    expect(extensions).toHaveValue("instance,");
    fireEvent.change(extensions, { target: { value: "instance,comment" } });
    fireEvent.blur(extensions);
    expect(extensions).toHaveValue("instance, comment");
    fireEvent.click(screen.getByRole("button", { name: "Save Only" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(expect.objectContaining({
        instance: expect.objectContaining({ patch: expect.objectContaining({ extensions: { model: ["instance", "comment"] } }) }),
    })));
});

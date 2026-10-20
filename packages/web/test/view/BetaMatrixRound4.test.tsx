import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Audit } from "../../src/view/page/activity/audit/Page.js";
import { Instances } from "../../src/view/page/Instances.js";
import { Todos } from "../../src/view/page/Todos.js";
import type { WebRoute } from "../../src/app/Route.js";
import { WebStore } from "../../src/state/Store.js";
import { withWebDomains } from "../support/DomainHarness.js";
import { deferred, setupAudit, setupConfig, setupTodos, todo } from "../support/BetaMatrixHarness.js";
import { round4Calls, round4Domains, round4Goal, startRound4Peer } from "../support/Round4Harness.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

// Production Application subscribes to store updates; preserve that composition
// when testing child views that read store.state rather than subscribing locally.
function StoreInstances({ store, instance, navigate, view }: { store: WebStore; instance: string; navigate: (route: WebRoute) => void; view?: "config" }) {
    useSyncExternalStore(store.subscribe, () => store.state);
    return <Instances store={store} navigate={navigate} route={{ page: "instances", instance, view }} />;
}

it("round4: SQLite-backed audit survives peer restart and paginates the same durable call identities", async () => {
    const directory = await mkdtemp(join(tmpdir(), "round4-web-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "activity.sqlite");
    const first = await startRound4Peer(database);
    await first.put("alpha", "calls", round4Calls(45));
    await first.close();
    const peer = await startRound4Peer(database); cleanup.push(() => peer.close());
    const domains = round4Domains(peer); cleanup.push(() => domains.close());
    await domains.toolCalls.load("alpha");
    const store = new WebStore(domains.harness.domains);
    render(withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "all" } }} />));
    expect(screen.getByText("Showing 1-20 of 45 matching tool calls.")).toBeInTheDocument();
    expect(screen.getByText("operation_044")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Showing 21-40 of 45 matching tool calls.")).toBeInTheDocument();
    expect(screen.getByText("operation_024")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Showing 41-45 of 45 matching tool calls.")).toBeInTheDocument();
    expect(screen.getByText("operation_000")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled();
    expect((await peer.read("alpha", "calls") as unknown[])).toHaveLength(45);
});

it("round4: real stream reloads authoritative audit output without losing the pending operation status", async () => {
    const directory = await mkdtemp(join(tmpdir(), "round4-stream-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const peer = await startRound4Peer(join(directory, "activity.sqlite")); cleanup.push(() => peer.close());
    const domains = round4Domains(peer); cleanup.push(() => domains.close());
    const calls = round4Calls(1); calls[0] = { ...calls[0]!, status: "running", output: undefined };
    await peer.put("alpha", "calls", calls); await domains.toolCalls.load("alpha");
    await waitFor(async () => expect((await peer.subscribers())["alpha:tool"]).toBe(1));
    const store = new WebStore(domains.harness.domains);
    render(withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "call", instance: "alpha", callId: "call-000" }} />));
    expect(within(screen.getByText("operation_000").closest("summary")!).getByText("running")).toBeInTheDocument();
    await act(async () => { await peer.put("alpha", "calls", [{ ...calls[0], status: "completed", output: { stdout: "durable-final-output" } }],
        { instanceName: "alpha", seq: 1, type: "toolCall.completed", at: "2026-10-20T00:01:00Z" }); });
    expect(await screen.findByText(/durable-final-output/u)).toBeInTheDocument();
    expect(within(screen.getByText("operation_000").closest("summary")!).getByText("completed")).toBeInTheDocument();
    expect(within(screen.getByText("operation_000").closest("summary")!).queryByText("running")).not.toBeInTheDocument();
});

it("round4: Goal and Todo streams refresh independent authoritative revisions over framed transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "round4-goal-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const peer = await startRound4Peer(join(directory, "activity.sqlite")); cleanup.push(() => peer.close());
    const domains = round4Domains(peer); cleanup.push(() => domains.close());
    await peer.put("alpha", "goals", { goals: [round4Goal(7)], lastSeq: 0 });
    await peer.put("alpha", "todo", { todo: todo("task-alpha", 3, "Transport task"), lastSeq: 0 });
    render(withWebDomains(domains.harness, <Todos store={new WebStore(domains.harness.domains)} />));
    expect(await screen.findByText("Verify round4 persistence")).toBeInTheDocument();
    expect(await screen.findByText("Transport task")).toBeInTheDocument();
    await waitFor(async () => expect((await peer.subscribers())["alpha:task"]).toBe(2));
    await act(async () => { await peer.put("alpha", "goals", { goals: [round4Goal(8, "completed")], lastSeq: 1 },
        { instanceName: "alpha", seq: 1, type: "goal.updated", at: "2026-10-20T00:01:00Z" }); });
    await waitFor(() => expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveTextContent("revision 8"));
    expect(screen.getByText("Transport task").closest("article")).toHaveTextContent("revision 3");
    await act(async () => { await peer.put("alpha", "todo", { todo: todo("task-alpha", 4, "Transport task revised"), lastSeq: 2 },
        { instanceName: "alpha", seq: 2, type: "todo.updated", at: "2026-10-20T00:02:00Z" }); });
    expect(await screen.findByText("Transport task revised")).toBeInTheDocument();
    expect(screen.getByText("Transport task revised").closest("article")).toHaveTextContent("revision 4");
    expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveAttribute("data-goal-status", "completed");
});

it("round4: approval rejection restores actions and a retry dispatches exactly once", async () => {
    const { domains } = setupAudit(); const first = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValueOnce(first.promise).mockResolvedValueOnce({});
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    await act(async () => first.reject(new Error("Policy reviewer unavailable: retry later")));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "Approve" })).not.toHaveAttribute("aria-disabled", "true");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(decide).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
});

it("round4: Audit refresh coalesces reentrant callers and reenables its control after success", async () => {
    const { domains, store } = setupAudit(); const pending = deferred<void>();
    const refresh = vi.spyOn(domains.instances, "refresh").mockReturnValue(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    const concurrent = store.refreshAudit();
    expect(screen.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await act(async () => { pending.resolve(); await concurrent; });
    expect(screen.getByRole("button", { name: "Refresh all" })).toBeEnabled();
    expect(refresh).toHaveBeenCalledOnce();
});

it("round4: Instance Delete stays pinned through route change, preserves exact failure, and permits retry", async () => {
    const { domains, store, unmount } = setupConfig(); unmount();
    const pending = deferred<void>(); const remove = vi.spyOn(domains.instances, "delete").mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    const navigate = vi.fn();
    const view = (instance: string) => withWebDomains(domains, <StoreInstances store={store} instance={instance} navigate={navigate} />);
    const mounted = render(view("alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledExactlyOnceWith("alpha"));
    mounted.rerender(view("beta"));
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete alpha?");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => pending.reject(new Error("Delete alpha refused: resource lease 42")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Delete alpha refused: resource lease 42");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove.mock.calls).toEqual([["alpha"], ["alpha"]]);
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ page: "instances" });
});

it("round4: reconnect releases disabled Config controls and retains the user's dirty draft", () => {
    const { domains } = setupConfig();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Log retention days" }), { target: { value: "31" } });
    act(() => domains.server.patch({ status: "offline" }));
    expect(screen.getByRole("button", { name: "Save & Restart" })).toBeDisabled();
    act(() => domains.server.patch({ status: "online" }));
    expect(screen.getByRole("button", { name: "Save & Restart" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(31);
});

it("round4: Todo failure preserves exact text and unlocks a deterministic retry", async () => {
    const { domains } = setupTodos(); const pending = deferred<void>();
    const remove = vi.spyOn(domains.todo("alpha"), "delete").mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    fireEvent.click(within(screen.getByText("Alpha project").closest("article")!).getByRole("button", { name: "Delete project" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(remove).toHaveBeenCalledOnce());
    await act(async () => pending.reject(new Error("Todo revision 3 is locked by checkpoint 9")));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent("Todo revision 3 is locked by checkpoint 9");
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(remove).toHaveBeenCalledTimes(2);
});


it("round4: switching instances during save cannot leave the replacement Config disabled after rejection", async () => {
    const { domains, store, unmount } = setupConfig(); unmount();
    const pending = deferred<unknown>();
    const update = vi.spyOn(domains.config, "update").mockReturnValue(pending.promise);
    const view = (instance: string) => withWebDomains(domains,
        <StoreInstances store={store} instance={instance} navigate={vi.fn()} view="config" />);
    const mounted = render(view("alpha"));
    fireEvent.click(screen.getByRole("checkbox", { name: "Workspace enabled" }));
    fireEvent.click(screen.getByRole("button", { name: "Save Only" }));
    await waitFor(() => expect(update).toHaveBeenCalledOnce());
    mounted.rerender(view("beta"));
    expect(screen.getByRole("checkbox", { name: "Workspace enabled" })).toBeDisabled();
    await act(async () => pending.reject(new Error("alpha config revision conflict: expected 7, got 8")));
    expect(store.state.error).toBe("alpha config revision conflict: expected 7, got 8");
    expect(screen.getByRole("checkbox", { name: "Workspace enabled" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Log retention days" })).toHaveValue(14);
    expect(screen.queryByText("Configuration saved.")).not.toBeInTheDocument();
    expect(update.mock.calls[0]![0].instance.instanceName).toBe("alpha");
});

it("round4: detached approval completion cannot disable or clear a replacement instance review", async () => {
    const { domains, store, unmount } = setupAudit(); unmount();
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const alpha = domains.approval("alpha").state.approvals[0];
    domains.setApprovals("beta", [{ ...alpha, instance: "beta", approvalId: "approval-beta", callId: "beta-call" }]);
    domains.setToolCalls("beta", [{ ...round4Calls(1)[0], instance: "beta", callId: "beta-call" }]);
    const pending = deferred<void>();
    const decide = vi.spyOn(domains.approval("alpha"), "decide").mockReturnValue(pending.promise);
    const betaDecision = vi.spyOn(domains.approval("beta"), "decide");
    const view = (instance: string) => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "instance", instance } }} />);
    const mounted = render(view("alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(decide).toHaveBeenCalledOnce());
    mounted.rerender(view("beta"));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(screen.getByRole("dialog")).toHaveTextContent("on beta");
    await act(async () => pending.resolve());
    expect(screen.getByRole("dialog")).toHaveTextContent("on beta");
    expect(betaDecision).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(betaDecision).toHaveBeenCalledExactlyOnceWith("approval-beta", "approve"));
});

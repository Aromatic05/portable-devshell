import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { Audit } from "../../src/view/page/activity/audit/Page.js";
import { Todos } from "../../src/view/page/Todos.js";
import { Instances } from "../../src/view/page/Instances.js";
import type { WebRoute } from "../../src/app/Route.js";
import { WebStore } from "../../src/state/Store.js";
import { round4Calls, round4Domains, round4Goal, startRound4Peer } from "../support/Round4Harness.js";
import { todo } from "../support/BetaMatrixHarness.js";
import { WebTestDomains, withWebDomains } from "../support/DomainHarness.js";
import { configView, deferred } from "../support/BetaMatrixHarness.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), "round5-web-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const database = join(directory, "runtime.sqlite");
    const peer = await startRound4Peer(database);
    cleanup.push(() => peer.close());
    const domains = round4Domains(peer);
    cleanup.push(() => domains.close());
    return { peer, domains, store: new WebStore(domains.harness.domains), database };
}

async function restartDomains(database: string, previous: ReturnType<typeof round4Domains>) {
    previous.close();
    const peer = await startRound4Peer(database);
    cleanup.push(() => peer.close());
    const domains = round4Domains(peer);
    cleanup.push(() => domains.close());
    return { peer, domains };
}

function StoreInstances({ store, instance, navigate }: { store: WebStore; instance: string; navigate(route: WebRoute): void }) {
    useSyncExternalStore(store.subscribe, () => store.state);
    return <Instances store={store} navigate={navigate} route={{ page: "instances", instance }} />;
}

function lifecycleFixture() {
    const domains = new WebTestDomains();
    domains.setConfig(configView());
    domains.setInstances(["alpha", "beta"].map((name) => ({ name, mcpEnabled: true,
        snapshot: { name, daemonState: "running", ready: true } })));
    return { domains, store: new WebStore(domains.domains) };
}

it("round5: durable completed activity reappears after the Audit component remounts", async () => {
    const { peer, domains, store, database } = await fixture();
    await peer.put("alpha", "calls", round4Calls(1));
    await domains.toolCalls.load("alpha");
    const route = { page: "audit", view: "timeline", scope: { kind: "all" } } as const;
    const renderAudit = () => withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined} route={route} />);
    const first = render(renderAudit());
    expect(await screen.findByText("operation_000")).toBeInTheDocument();
    first.unmount();
    const restarted = await restartDomains(database, domains);
    const freshStore = new WebStore(restarted.domains.harness.domains);
    const replay = render(withWebDomains(restarted.domains.harness, <Audit store={freshStore} navigate={() => undefined} route={route} />));
    expect(screen.queryByText("operation_000")).not.toBeInTheDocument();
    await restarted.domains.toolCalls.load("alpha");
    expect(await screen.findByText("operation_000")).toBeInTheDocument();
    expect(await peer.read("alpha", "calls")).toMatchObject([{ callId: "call-000", output: { stdout: "result-0" } }]);
    replay.unmount();
});

it("round5: persisted running call output is restored on a new Audit mount", async () => {
    const { peer, domains, store, database } = await fixture();
    const call = round4Calls(1)[0]!;
    await peer.put("alpha", "calls", [{ ...call, status: "running", output: undefined }]);
    await domains.toolCalls.load("alpha");
    const route = { page: "audit", view: "call", instance: "alpha", callId: call.callId } as const;
    const first = render(withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined} route={route} />));
    expect((await screen.findAllByText("running")).length).toBeGreaterThan(0);
    first.unmount();
    await peer.put("alpha", "calls", [{ ...call, output: { stdout: "crash-recovered-output" } }]);
    const restarted = await restartDomains(database, domains);
    await restarted.domains.toolCalls.load("alpha");
    render(withWebDomains(restarted.domains.harness, <Audit store={new WebStore(restarted.domains.harness.domains)} navigate={() => undefined} route={route} />));
    expect(await screen.findByText(/crash-recovered-output/u)).toBeInTheDocument();
    expect(screen.getByText("operation_000").closest("summary")).toHaveTextContent("completed");
});

it("round5: stream event arriving while mounted is durable and survives a later replay", async () => {
    const { peer, domains, store, database } = await fixture();
    const call = round4Calls(1)[0]!;
    await peer.put("alpha", "calls", [{ ...call, status: "running", output: undefined }]);
    await domains.toolCalls.load("alpha");
    await waitFor(async () => expect((await peer.subscribers())["alpha:tool"]).toBe(1));
    const route = { page: "audit", view: "call", instance: "alpha", callId: call.callId } as const;
    const first = render(withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined} route={route} />));
    await act(async () => peer.put("alpha", "calls", [{ ...call, output: { stdout: "stream-then-replay" } }],
        { instanceName: "alpha", seq: 1, type: "toolCall.completed", at: "2026-10-20T00:01:00Z" }));
    expect(await screen.findByText(/stream-then-replay/u)).toBeInTheDocument();
    first.unmount();
    const restarted = await restartDomains(database, domains);
    await restarted.domains.toolCalls.load("alpha");
    render(withWebDomains(restarted.domains.harness, <Audit store={new WebStore(restarted.domains.harness.domains)} navigate={() => undefined} route={route} />));
    expect(await screen.findByText(/stream-then-replay/u)).toBeInTheDocument();
});

it("round5: persisted records stay instance scoped when another instance reloads", async () => {
    const { peer, domains, store, database } = await fixture();
    await peer.put("alpha", "calls", round4Calls(1));
    await peer.put("beta", "calls", round4Calls(1).map((call) => ({ ...call, instance: "beta", callId: "beta-call", toolName: "beta_operation" })));
    await domains.toolCalls.load("alpha"); await domains.toolCalls.load("beta");
    render(withWebDomains(domains.harness, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "instance", instance: "beta" } }} />));
    expect(await screen.findByText("beta_operation")).toBeInTheDocument();
    expect(screen.queryByText("operation_000")).not.toBeInTheDocument();
    expect(await peer.read("alpha", "calls")).toHaveLength(1);
    expect(await peer.read("beta", "calls")).toHaveLength(1);
});

it("round5: crash-recovered goal completion and newer revision render together", async () => {
    const { peer, domains, store, database } = await fixture();
    await peer.put("alpha", "goals", { goals: [round4Goal(12, "completed")], lastSeq: 12 });
    await domains.goals.load("alpha");
    render(withWebDomains(domains.harness, <Todos store={store} />));
    expect(await screen.findByText("Verify round4 persistence")).toBeInTheDocument();
    expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveAttribute("data-goal-status", "completed");
    expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveTextContent("revision 12");
});

it("round5: Todo snapshot revision and content recover from SQLite after remount", async () => {
    const { peer, domains, store, database } = await fixture();
    await peer.put("alpha", "todo", { todo: todo("persisted-task", 6, "Recovered task"), lastSeq: 6 });
    await domains.todos.get("alpha")!.load();
    const first = render(withWebDomains(domains.harness, <Todos store={store} />));
    expect(await screen.findByText("Recovered task")).toBeInTheDocument();
    first.unmount();
    const restarted = await restartDomains(database, domains);
    await restarted.domains.todos.get("alpha")!.load();
    render(withWebDomains(restarted.domains.harness, <Todos store={new WebStore(restarted.domains.harness.domains)} />));
    expect(await screen.findByText("Recovered task")).toBeInTheDocument();
    expect(screen.getByText("Recovered task").closest("article")).toHaveTextContent("revision 6");
});

it("round5: goal stream revision supersedes stale mounted snapshot and remains after remount", async () => {
    const { peer, domains, store, database } = await fixture();
    await peer.put("alpha", "goals", { goals: [round4Goal(2)], lastSeq: 2 });
    await domains.goals.load("alpha");
    await waitFor(async () => expect((await peer.subscribers())["alpha:task"]).toBe(1));
    const first = render(withWebDomains(domains.harness, <Todos store={store} />));
    expect(await screen.findByText("Verify round4 persistence")).toBeInTheDocument();
    await act(async () => peer.put("alpha", "goals", { goals: [round4Goal(3, "completed")], lastSeq: 3 },
        { instanceName: "alpha", seq: 3, type: "goal.updated", at: "2026-10-20T00:03:00Z" }));
    await waitFor(() => expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveTextContent("revision 3"));
    expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveAttribute("data-goal-status", "completed");
    first.unmount();
    const restarted = await restartDomains(database, domains);
    await restarted.domains.goals.load("alpha");
    render(withWebDomains(restarted.domains.harness, <Todos store={new WebStore(restarted.domains.harness.domains)} />));
    expect(await screen.findByText("Verify round4 persistence")).toBeInTheDocument();
    expect(screen.getByText("Verify round4 persistence").closest("article")).toHaveTextContent("revision 3");
});

it("round5: failed Todo delete preserves durable revision and retries only after explicit user action", async () => {
    const { peer, domains, store } = await fixture();
    await peer.put("alpha", "todo", { todo: todo("task", 8, "Protected durable task"), lastSeq: 8 });
    await domains.todos.get("alpha")!.load();
    const failure = new Error("Todo revision 8 is locked by recovery checkpoint 21");
    domains.todos.get("alpha")!.delete = async () => { throw failure; };
    const view = render(withWebDomains(domains.harness, <Todos store={store} />));
    expect(await screen.findByText("Protected durable task")).toBeInTheDocument();
    expect(await peer.read("alpha", "todo")).toMatchObject({ todo: { revision: 8 } });
    view.unmount();
    expect(await peer.read("alpha", "todo")).toMatchObject({ todo: { taskId: "task", revision: 8 } });
});

it("round5: instance deletion cleanup debt is shown after successful deregistration", async () => {
    const { domains, store } = lifecycleFixture();
    domains.instances.delete = async () => ({ cleanupPending: true });
    const navigate = vi.fn();
    render(withWebDomains(domains, <StoreInstances store={store} instance="alpha" navigate={navigate} />));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(store.state.notice).toBe("alpha deregistered, but lifecycle cleanup is still pending. Review Control logs before reusing this name."));
    expect(navigate).toHaveBeenCalledWith({ page: "instances" });
});

it("round5: a delayed deletion for alpha cannot replace beta selection or beta feedback", async () => {
    const { domains, store } = lifecycleFixture();
    const pending = deferred<unknown>();
    domains.instances.delete = () => pending.promise;
    const navigate = vi.fn();
    const view = (instance: string) => withWebDomains(domains, <StoreInstances store={store} instance={instance} navigate={navigate} />);
    const mounted = render(view("alpha"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    mounted.rerender(view("beta"));
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete alpha?");
    expect(screen.getByRole("dialog")).toHaveAttribute("aria-busy", "true");
    await act(async () => pending.reject(new Error("alpha cleanup handoff is still unresolved")));
    expect(screen.getByRole("dialog")).toHaveTextContent("alpha cleanup handoff is still unresolved");
    expect(screen.getByRole("link", { name: /beta/u })).toHaveAttribute("aria-current", "page");
    expect(domains.instances.state.instances).toHaveLength(2);
});

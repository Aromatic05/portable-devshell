import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { asInstanceName, MessageHistoryViewModel, ToolCallViewModel } from "@portable-devshell/shared";
import type { MessageListResult } from "../../../../shared/src/workspace/message/Model.js";
import type { MessageTransport } from "../../../../shared/src/workspace/message/Transport.js";
import type { ToolTransport } from "../../../../shared/src/execution/toolcall/Transport.js";
import { afterEach, expect, it, vi } from "vitest";
import { Messages } from "../../../src/view/page/activity/messages/Page.js";
import { Audit } from "../../../src/view/page/activity/audit/Page.js";
import * as Export from "../../../src/view/page/activity/messages/Export.js";
import { WebStore } from "../../../src/state/Store.js";
import { WebTestDomains, withWebDomains } from "../../support/DomainHarness.js";
import { auditCall, deferred } from "../../support/BetaMatrixHarness.js";

const message = { id: "new", ctxId: "ctx", createdAt: "2026-10-28T01:00:00Z", kind: "comment" as const, text: "Newest comment" };
const report = { ...message, id: "old", createdAt: "2026-10-27T01:00:00Z", kind: "report" as const, text: "Oldest report" };
const initial = { entries: [message], lastSeq: 1 };
const empty = { entries: [], lastSeq: 1 };
const route = { page: "messages", view: "thread", instance: "alpha", ctxId: "ctx" } as const;

afterEach(() => vi.restoreAllMocks());

async function exportSetup(list: MessageTransport["listMessageEntries"]) {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha" }]);
    const history = new MessageHistoryViewModel({ transport: { listMessageEntries: list } as MessageTransport });
    Object.assign(domains.domains, { messageHistory: history });
    const store = new WebStore(domains.domains);
    vi.spyOn(store, "refreshMessages").mockResolvedValue(undefined);
    const view = (ctxId = "ctx") => withWebDomains(domains, <Messages store={store} navigate={() => undefined} route={{ ...route, ctxId }} />);
    const mounted = render(view());
    await waitFor(() => expect(history.state.context?.loading).toBe(false));
    const download = vi.spyOn(Export, "downloadMarkdown").mockImplementation(() => undefined);
    return { domains, history, download, mounted, view };
}

it("exports every page and the empty boundary with one click, using message merge and order semantics", async () => {
    const boundary = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>()
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({ entries: [report, message], lastSeq: 1 })
        .mockReturnValueOnce(boundary.promise);
    const { download } = await exportSetup(list);
    fireEvent.change(screen.getByLabelText("Comment"), { target: { value: "Keep my draft" } });
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/loaded messages only|Filters search loaded history/u)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toHaveAttribute("title", "Export Markdown");
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    expect(screen.getByText("Exporting…")).toBeDisabled();
    expect(download).not.toHaveBeenCalled();
    await act(async () => boundary.resolve(empty));
    expect(download).toHaveBeenCalledOnce();
    const markdown = download.mock.calls[0]![1];
    expect(markdown).toContain("Exported messages: 2");
    expect(markdown.indexOf("Oldest report")).toBeLessThan(markdown.indexOf("Newest comment"));
    expect(markdown).not.toContain("loaded messages only");
    expect(list.mock.calls.map(([, input]) => input?.before)).toEqual([undefined, "new", "old"]);
    expect(screen.getByRole("status")).toHaveTextContent("Exported 2 messages.");
    expect(screen.getByLabelText("Comment")).toHaveValue("Keep my draft");
});

it("does not download partial history after failure and retries from the failed cursor", async () => {
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockResolvedValueOnce({ entries: [report], lastSeq: 1 })
        .mockRejectedValueOnce(new Error("Archive unavailable"))
        .mockResolvedValueOnce(empty);
    const { download } = await exportSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive unavailable");
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    expect(list.mock.calls.map(([, input]) => input?.before)).toEqual([undefined, "new", "old", "old"]);
});

it("cancels an export when Context changes, without downloading the old selection", async () => {
    const page = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockReturnValueOnce(page.promise).mockResolvedValue(empty);
    const { mounted, view, download } = await exportSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    mounted.rerender(view("other"));
    expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled");
    await act(async () => page.resolve(empty));
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("Export cancelled");
});

it.each(["offline", "stalled"])("fails export visibly without a partial file when %s", async (problem) => {
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValue(initial);
    const { domains, download } = await exportSetup(list);
    if (problem === "offline") act(() => domains.server.patch({ status: "offline" }));
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Export failed");
    expect(download).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(problem === "offline" ? 1 : 2);
});

const call = { ...auditCall, ctxId: "ctx", callId: "new" };
const olderCall = { ...call, callId: "old", toolName: "needle" };
async function auditSetup(list: ToolTransport["listCalls"]) {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha" }]);
    const history = new ToolCallViewModel({ cursor: async () => 0, transport: () => ({ listCalls: list } as unknown as ToolTransport) });
    Object.assign(domains.domains, { toolCalls: history });
    const store = new WebStore(domains.domains);
    const view = (ctxId = "ctx") => withWebDomains(domains, <Audit store={store} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "context", instance: "alpha", ctxId } }} />);
    const mounted = render(view());
    await waitFor(() => expect(history.state.context?.loading).toBe(false));
    fireEvent.change(screen.getByRole("searchbox", { name: "Search audit" }), { target: { value: "needle" } });
    return { domains, history, mounted, view };
}

it("searches all historic audit pages including the empty boundary on one click, without fetching on typing", async () => {
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call])
        .mockResolvedValueOnce([{ ...call, callId: "middle" }]).mockResolvedValueOnce([olderCall]).mockResolvedValueOnce([]);
    await auditSetup(list);
    expect(list).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No matches found yet.")).toBeInTheDocument();
    expect(screen.queryByText(/Filters search loaded history/u)).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search loaded audit")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(screen.getByText("needle")).toBeInTheDocument();
    expect(list.mock.calls.map(([query]) => query?.before)).toEqual([undefined, "new", "middle", "old"]);
});

it("only declares no matches after reaching the empty history boundary", async () => {
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call]).mockResolvedValueOnce([]);
    await auditSetup(list);
    expect(screen.queryByText("No tool calls match these filters.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    expect(await screen.findByText("No tool calls match these filters.")).toBeInTheDocument();
});

it("keeps search failure retryable without declaring history empty", async () => {
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call])
        .mockRejectedValueOnce(new Error("Archive unavailable")).mockResolvedValueOnce([olderCall]).mockResolvedValueOnce([]);
    await auditSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Archive unavailable");
    expect(screen.queryByText("No tool calls match these filters.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(screen.getByText("needle")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it.each(["filter", "route", "cancel", "offline"])("stops subsequent audit pages after %s changes during a request", async (reason) => {
    const page = deferred<typeof call[]>();
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call]).mockReturnValueOnce(page.promise).mockResolvedValue([]);
    const { domains, mounted, view } = await auditSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    expect(screen.getByRole("button", { name: "Searching audit…" })).toBeDisabled();
    if (reason === "filter") fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "other" } });
    if (reason === "route") mounted.rerender(view("other"));
    if (reason === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    if (reason === "offline") act(() => domains.server.patch({ status: "offline" }));
    await act(async () => page.resolve([olderCall]));
    expect(list).toHaveBeenCalledTimes(reason === "route" ? 3 : 2);
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
});

it("stops repeated audit cursors visibly instead of looping", async () => {
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValue([call]);
    await auditSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Search could not advance");
    expect(list).toHaveBeenCalledTimes(2);
});

it.each(["instance", "all"] as const)("searches paginated instance ledgers for %s scope in one action", async (scope) => {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const alpha = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call])
        .mockResolvedValueOnce([{ ...call, callId: "middle" }]).mockResolvedValueOnce([olderCall]).mockResolvedValueOnce([]);
    const beta = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([{ ...call, instance: asInstanceName("beta") }])
        .mockResolvedValueOnce([{ ...olderCall, instance: asInstanceName("beta") }]).mockResolvedValueOnce([]);
    const transports = { alpha, beta };
    const history = new ToolCallViewModel({ cursor: async () => 0,
        transport: (instance) => ({ listCalls: transports[instance as keyof typeof transports] } as unknown as ToolTransport) });
    await Promise.all([history.refresh("alpha"), history.refresh("beta")]);
    Object.assign(domains.domains, { toolCalls: history });
    render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: scope === "all" ? { kind: "all" } : { kind: "instance", instance: "alpha" } }} />));
    fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "needle" } });
    expect(alpha).toHaveBeenCalledOnce();
    expect(beta).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument());
    expect(alpha).toHaveBeenCalledTimes(4);
    expect(beta).toHaveBeenCalledTimes(scope === "all" ? 3 : 1);
    expect(screen.getAllByText("needle")).toHaveLength(scope === "all" ? 2 : 1);
});


it("blocks a download if connectivity is lost during export and permits retry after reconnecting", async () => {
    const page = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockReturnValueOnce(page.promise).mockResolvedValue(empty);
    const { domains, download } = await exportSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    act(() => domains.server.patch({ status: "offline" }));
    await act(async () => page.resolve(empty));
    expect(await screen.findByRole("alert")).toHaveTextContent("Reconnect and retry");
    expect(download).not.toHaveBeenCalled();
    act(() => domains.server.patch({ status: "online" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
});

it("times out an unresolved second export page, aborts its signal and retries without accepting a late page", async () => {
    const page = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockReturnValueOnce(page.promise).mockResolvedValueOnce(empty);
    const { download, history } = await exportSetup(list);
    vi.useFakeTimers();
    try {
        fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
        expect(list).toHaveBeenCalledTimes(2);
        const signal = list.mock.calls[1]![2]!;
        expect(signal.aborted).toBe(false);
        await act(async () => vi.advanceTimersByTimeAsync(30_000));
        expect(signal.aborted).toBe(true);
        expect(screen.getByRole("alert")).toHaveTextContent("timed out");
        expect(screen.getByRole("button", { name: "Export Markdown" })).toBeEnabled();
        expect(download).not.toHaveBeenCalled();
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export Markdown" })));
        expect(download).toHaveBeenCalledOnce();
        await act(async () => page.resolve({ entries: [report], lastSeq: 1 }));
        expect(history.state.context?.entries.map((entry) => entry.id)).toEqual(["new"]);
        expect(download).toHaveBeenCalledOnce();
    } finally {
        vi.useRealTimers();
    }
});

it.each(["unmount", "route"] as const)("aborts an unresolved export page on %s without a partial download", async (reason) => {
    const page = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockReturnValueOnce(page.promise).mockResolvedValue(empty);
    const { mounted, view, download, history } = await exportSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    expect(list).toHaveBeenCalledTimes(2);
    const signal = list.mock.calls[1]![2]!;
    const actions = { unmount: () => mounted.unmount(), route: () => mounted.rerender(view("other")) };
    actions[reason]();
    await act(async () => undefined);
    expect(signal.aborted).toBe(true);
    expect(download).not.toHaveBeenCalled();
    await act(async () => page.resolve({ entries: [report], lastSeq: 1 }));
    expect(history.state.context?.entries.some((entry) => entry.id === "old")).not.toBe(true);
    expect(download).not.toHaveBeenCalled();
});

it("cancels an unresolved export page and retries before its late response", async () => {
    const page = deferred<MessageListResult>();
    const list = vi.fn<MessageTransport["listMessageEntries"]>().mockResolvedValueOnce(initial)
        .mockReturnValueOnce(page.promise).mockResolvedValue(empty);
    const { download, history } = await exportSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    const signal = list.mock.calls[1]![2]!;
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    await act(async () => undefined);
    expect(signal.aborted).toBe(true);
    expect(download).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export Markdown" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Export Markdown" }));
    await waitFor(() => expect(download).toHaveBeenCalledOnce());
    await act(async () => page.resolve({ entries: [report], lastSeq: 1 }));
    expect(history.state.context?.entries.map((entry) => entry.id)).toEqual(["new"]);
    expect(download).toHaveBeenCalledOnce();
});

it("continues all-instance history search after alpha fails and exposes beta's match with alpha's failure", async () => {
    const domains = new WebTestDomains();
    domains.setInstances([{ name: "alpha" }, { name: "beta" }]);
    const alpha = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call])
        .mockRejectedValue(new Error("Alpha archive unavailable"));
    const beta = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([{ ...call, instance: asInstanceName("beta") }])
        .mockResolvedValueOnce([{ ...olderCall, instance: asInstanceName("beta") }]).mockResolvedValueOnce([]);
    const transports = { alpha, beta };
    const history = new ToolCallViewModel({ cursor: async () => 0,
        transport: (instance) => ({ listCalls: transports[instance as keyof typeof transports] } as unknown as ToolTransport) });
    await Promise.all([history.refresh("alpha"), history.refresh("beta")]);
    Object.assign(domains.domains, { toolCalls: history });
    render(withWebDomains(domains, <Audit store={new WebStore(domains.domains)} navigate={() => undefined}
        route={{ page: "audit", view: "timeline", scope: { kind: "all" } }} />));
    fireEvent.change(screen.getByLabelText("Search audit"), { target: { value: "needle" } });
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    await waitFor(() => expect(beta).toHaveBeenCalledTimes(3));
    expect(screen.getByText("needle")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("alpha: Alpha archive unavailable");
    expect(screen.queryByText("No tool calls match these filters.")).not.toBeInTheDocument();
});

it("cancels an unresolved audit page and retries immediately without merging its late response", async () => {
    const page = deferred<typeof call[]>();
    const list = vi.fn<ToolTransport["listCalls"]>().mockResolvedValueOnce([call])
        .mockReturnValueOnce(page.promise).mockResolvedValueOnce([olderCall]).mockResolvedValueOnce([]);
    const { history } = await auditSetup(list);
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Search older Tool Calls" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    expect(screen.getByText("needle")).toBeInTheDocument();
    await act(async () => page.resolve([{ ...olderCall, callId: "late" }]));
    expect(history.state.context?.calls.map((item) => item.callId)).toEqual(["new", "old"]);
    expect(list).toHaveBeenCalledTimes(4);
});

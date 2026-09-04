import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { asInstanceName, createInitialControlReadModelState } from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { ToolCalls } from "../src/views/ToolCalls.js";
import type { WebState, WebStore } from "../src/state/WebStore.js";

const alphaCall = {
    callId: "call-alpha",
    completedAt: "2026-07-31T09:00:01Z",
    ctxId: "ctx-alpha",
    explanation: "The previous run returned a non-zero exit code.",
    input: { command: "false" },
    inputSummary: '{"command":"false"}',
    instance: asInstanceName("alpha"),
    output: { exitCode: 1, stderr: "failed", stdout: "" },
    purpose: "Confirm the failing command",
    source: "mcp" as const,
    startedAt: "2026-07-31T09:00:00Z",
    status: "failed" as const,
    toolName: "bash_run",
    workspace: "/projects/alpha",
};

const state: WebState = {
    connection: "online",
    operations: {},
    readModel: {
        ...createInitialControlReadModelState(),
        contexts: [{
            createdAt: "2026-07-31T08:00:00Z",
            ctxId: "ctx-alpha",
            expiresAt: "2026-08-01T08:00:00Z",
            instance: "alpha",
            lastAccessedAt: "2026-07-31T09:00:00Z",
            principal: "client-alpha",
            status: "active",
            workspace: "/workspace/alpha",
        }, {
            createdAt: "2026-07-31T08:00:00Z",
            ctxId: "ctx-beta",
            expiresAt: "2026-08-01T08:00:00Z",
            instance: "beta",
            lastAccessedAt: "2026-07-31T09:00:00Z",
            principal: "client-beta",
            status: "active",
            workspace: "/workspace/beta",
        }],
        instances: [
            {
                mcpEnabled: true,
                name: "alpha",
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("alpha"),
                    ready: true,
                    status: "ready",
                },
            },
            {
                mcpEnabled: true,
                name: "beta",
                snapshot: {
                    connectionState: "connected",
                    daemonState: "running",
                    lastSeq: 1,
                    name: asInstanceName("beta"),
                    ready: true,
                    status: "ready",
                },
            },
        ],
        instanceState: {
            alpha: {
                approvals: [],
                commentCalls: [{
                    callId: "call-comment-old",
                    completedAt: "2026-07-30T09:00:01Z",
                    ctxId: "ctx-alpha",
                    input: { command: "pwd" },
                    inputSummary: '{"command":"pwd"}',
                    instance: asInstanceName("alpha"),
                    output: { comment: ["Review the previous failure."], exitCode: 0, stderr: "", stdout: "/workspace\n" },
                    source: "mcp",
                    startedAt: "2026-07-30T09:00:00Z",
                    status: "completed",
                    toolName: "bash_run",
                }],
                contextMessages: [{
                    createdAt: "2026-07-31T09:05:00Z",
                    ctxId: "ctx-alpha",
                    id: "message-1",
                    instance: "alpha",
                    status: "pending",
                    text: "Check the failing command.",
                }],
                logs: [],
                sequence: 1,
                toolCalls: [alphaCall],
            },
            beta: {
                approvals: [],
                commentCalls: [],
                contextMessages: [],
                logs: [],
                sequence: 1,
                toolCalls: [{
                    callId: "call-beta",
                    completedAt: "2026-07-31T09:10:01Z",
                    ctxId: "ctx-beta",
                    inputSummary: '{"path":"README.md"}',
                    instance: asInstanceName("beta"),
                    source: "mcp",
                    startedAt: "2026-07-31T09:10:00Z",
                    status: "completed",
                    toolName: "file_read",
                }],
            },
        },
    },
};

it("filters structured tool calls by ctxId and queues a Comment for the selected Context", async () => {
    const queueContextMessage = vi.fn(async () => true);
    const store = { queueContextMessage } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    fireEvent.change(screen.getByLabelText("Search"), {
        target: { value: "file_read" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Search"), {
        target: { value: "previous run returned" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    fireEvent.change(screen.getByLabelText("Workspace"), {
        target: { value: "projects/alpha" },
    });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("alpha · alpha")).toBeInTheDocument();
    expect(screen.getByText("ctx ctx-alpha")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));

    fireEvent.change(screen.getByLabelText("Instance"), {
        target: { value: "alpha" },
    });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });
    expect(screen.getByText(/Workspace: \/workspace\/alpha/u)).toBeInTheDocument();
    expect(screen.getByText("Check the failing command.")).toBeInTheDocument();
    expect(screen.getByText("Review the previous failure.")).toBeInTheDocument();
    expect(screen.getByText("call-comment-old")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Comment"), {
        target: { value: "Retry after checking the environment." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Queue Comment" }));

    await waitFor(() =>
        expect(queueContextMessage).toHaveBeenCalledWith(
            "alpha",
            "ctx-alpha",
            "Retry after checking the environment.",
        ),
    );
});

it("refreshes an expanded tool call to retrieve its latest content", async () => {
    const refreshToolCall = vi.fn(async () => undefined);
    const store = { refreshToolCall } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    fireEvent.click(screen.getByText("bash_run", { selector: "strong" }));
    expect(await screen.findByText("/projects/alpha")).toBeInTheDocument();
    expect(screen.getByText("Confirm the failing command")).toBeInTheDocument();
    expect(screen.getByText("The previous run returned a non-zero exit code.")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(refreshToolCall).toHaveBeenCalledWith("alpha"));
});

it("refreshes the whole Audit surface without resetting filters or an expanded call", async () => {
    const refreshAudit = vi.fn(async () => undefined);
    const store = {
        queueContextMessage: vi.fn(async () => true),
        refreshAudit,
    } as unknown as WebStore;
    const view = render(<ToolCalls state={state} store={store} />);

    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });
    fireEvent.click(screen.getByText("bash_run", { selector: "strong" }));
    expect(await screen.findByText("Call")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Refresh all" }));
    await waitFor(() => expect(refreshAudit).toHaveBeenCalledOnce());

    view.rerender(<ToolCalls
        state={{
            ...state,
            readModel: {
                ...state.readModel,
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        toolCalls: [{
                            ...alphaCall,
                            output: { exitCode: 1, stderr: "failed", stdout: "refreshed-output" },
                        }],
                    },
                },
            },
        }}
        store={store}
    />);

    expect(screen.getByLabelText("Instance")).toHaveValue("alpha");
    expect(screen.getByLabelText("Context")).toHaveValue("context:ctx-alpha");
    expect(screen.getByText(/refreshed-output/u)).toBeInTheDocument();
});

it("filters inactive Contexts in a separate window and disables only the reviewed selection", async () => {
    const now = Date.now();
    const contextState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            contexts: [{
                ...state.readModel.contexts[0]!,
                ctxId: "ctx-hour",
                lastAccessedAt: new Date(now - 2 * 60 * 60 * 1_000).toISOString(),
                workspace: "/projects/hour",
            }, {
                ...state.readModel.contexts[0]!,
                ctxId: "ctx-twenty",
                lastAccessedAt: new Date(now - 30 * 60 * 1_000).toISOString(),
                workspace: "/projects/twenty",
            }, {
                ...state.readModel.contexts[0]!,
                ctxId: "ctx-recent",
                lastAccessedAt: new Date(now - 5 * 60 * 1_000).toISOString(),
            }, {
                ...state.readModel.contexts[0]!,
                ctxId: "ctx-disabled",
                lastAccessedAt: new Date(now - 3 * 60 * 60 * 1_000).toISOString(),
                status: "disabled",
            }],
        },
    };
    const disableContexts = vi.fn(async () => true);
    const store = {
        disableContexts,
        queueContextMessage: vi.fn(async () => true),
    } as unknown as WebStore;
    render(<ToolCalls state={contextState} store={store} />);

    fireEvent.click(screen.getByRole("button", { name: "Manage Contexts" }));
    const dialog = screen.getByRole("dialog", { name: "Disable inactive Contexts" });
    expect(within(dialog).getByText("ctx-hour")).toBeInTheDocument();
    expect(within(dialog).getByText("/projects/hour")).toBeInTheDocument();
    expect(within(dialog).queryByText("ctx-twenty")).not.toBeInTheDocument();
    expect(within(dialog).queryByText("ctx-disabled")).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("Inactive for"), {
        target: { value: "20" },
    });
    expect(within(dialog).getByText("ctx-twenty")).toBeInTheDocument();
    expect(within(dialog).getByText("/projects/twenty")).toBeInTheDocument();
    expect(within(dialog).queryByText("ctx-recent")).not.toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Select ctx-twenty" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Review disable" }));
    expect(disableContexts).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Disable 1 Context" }));

    await waitFor(() => expect(disableContexts).toHaveBeenCalledWith(["ctx-twenty"]));
});

it("locks the instance from the selected Context", () => {
    const queueContextMessage = vi.fn(async () => true);
    const store = { queueContextMessage } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "context:ctx-alpha" } });

    expect(screen.getByLabelText("Instance")).toHaveValue("alpha");
    expect(screen.getByLabelText("Instance")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Queue Comment" })).toBeInTheDocument();
    expect(queueContextMessage).not.toHaveBeenCalled();
});

it("shows Context renewal as pending and prevents duplicate renewal", () => {
    const renewContext = vi.fn(async () => true);
    const store = { renewContext } as unknown as WebStore;
    render(<ToolCalls
        state={{ ...state, operations: { "context-renew:ctx-alpha": "pending" } }}
        store={store}
    />);

    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "context:ctx-alpha" } });

    expect(screen.getByRole("button", { name: "Renewing…" })).toBeDisabled();
    expect(renewContext).not.toHaveBeenCalled();
});

it("keeps the instance selectable when one Context is attached to multiple instances", () => {
    const multiInstanceState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            contexts: state.readModel.contexts.map((context) => context.ctxId === "ctx-alpha"
                ? {
                    ...context,
                    environments: [
                        { instance: "alpha", workspace: "/workspace/alpha" },
                        { instance: "beta", workspace: "/workspace/remote" },
                    ],
                }
                : context),
        },
    };
    const store = { queueContextMessage: vi.fn(async () => true) } as unknown as WebStore;
    render(<ToolCalls state={multiInstanceState} store={store} />);

    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "context:ctx-alpha" } });
    expect(screen.getByLabelText("Instance")).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "beta" } });
    expect(screen.getByLabelText("Context")).toHaveValue("context:ctx-alpha");
    expect(screen.getByText(/\/workspace\/remote/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Queue Comment" })).toBeInTheDocument();
});

it("does not offer Comment composition for a disabled Context", () => {
    const disabledState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            contexts: state.readModel.contexts.map((context) => context.ctxId === "ctx-alpha"
                ? { ...context, status: "disabled" as const }
                : context),
        },
    };
    const store = { queueContextMessage: vi.fn(async () => true) } as unknown as WebStore;
    render(<ToolCalls state={disabledState} store={store} />);

    fireEvent.change(screen.getByLabelText("Context status"), { target: { value: "disabled" } });
    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "context:ctx-alpha" } });

    expect(screen.queryByRole("button", { name: "Queue Comment" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Comment")).not.toBeInTheDocument();
    expect(screen.getByText(/Comments can only be queued for an active Context/u)).toBeInTheDocument();
});

it("requires confirmation before disabling a Context", async () => {
    const disableContext = vi.fn(async () => true);
    const store = {
        disableContext,
        queueContextMessage: vi.fn(async () => true),
    } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Disable Context" }));

    expect(disableContext).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Confirm disable" });
    expect(within(dialog).getByText(/\/workspace\/alpha/u)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Disable" }));

    await waitFor(() => expect(disableContext).toHaveBeenCalledWith("ctx-alpha"));
});

it("does not render large Tool Call details until the row is expanded", () => {
    const token = "large-output-token";
    const output = `${token}${"x".repeat(200_000)}`;
    const largeState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            instanceState: {
                ...state.readModel.instanceState,
                alpha: {
                    ...state.readModel.instanceState.alpha!,
                    toolCalls: [{ ...alphaCall, callId: "large-call", output }],
                },
            },
        },
    };
    render(<ToolCalls state={largeState} store={{ queueContextMessage: vi.fn() } as unknown as WebStore} />);

    expect(screen.queryByText(new RegExp(token))).not.toBeInTheDocument();
    const details = screen.getByText("alpha · alpha").closest("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText(new RegExp(token))).toBeInTheDocument();
});

it("normalizes a Context filter that disappears after refresh", () => {
    const store = { queueContextMessage: vi.fn() } as unknown as WebStore;
    const view = render(<ToolCalls state={state} store={store} />);
    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });

    view.rerender(<ToolCalls
        state={{
            ...state,
            readModel: {
                ...state.readModel,
                contexts: [],
                instanceState: {
                    ...state.readModel.instanceState,
                    alpha: {
                        ...state.readModel.instanceState.alpha!,
                        commentCalls: [],
                        contextMessages: [],
                        toolCalls: [{ ...alphaCall, ctxId: "ctx-new" }],
                    },
                },
            },
        }}
        store={store}
    />);

    expect(screen.getByLabelText("Context")).toHaveValue("all");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
});

it("paginates matching tool calls", () => {
    const manyState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            instanceState: {
                ...state.readModel.instanceState,
                alpha: {
                    ...state.readModel.instanceState.alpha!,
                    toolCalls: Array.from({ length: 150 }, (_, index) => ({
                        ...alphaCall,
                        callId: `call-${index}`,
                        startedAt: `2026-07-31T09:${String(index % 60).padStart(2, "0")}:00Z`,
                    })),
                },
            },
        },
    };

    const view = render(<ToolCalls
        state={manyState}
        store={{ queueContextMessage: vi.fn() } as unknown as WebStore}
    />);

    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(20);
    const pagination = screen.getByRole("navigation", { name: "Tool calls pagination" });
    expect(pagination).toHaveTextContent("Page 1 of 8");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(20);
    expect(pagination).toHaveTextContent("Page 2 of 8");
});

it("filters Contexts and tool calls by status, defaulting to active", () => {
    const expiredContextState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            contexts: [
                ...state.readModel.contexts,
                {
                    createdAt: "2026-07-30T08:00:00Z",
                    ctxId: "ctx-expired",
                    expiresAt: "2026-07-31T08:00:00Z",
                    instance: "alpha",
                    lastAccessedAt: "2026-07-31T07:00:00Z",
                    principal: "client-alpha",
                    status: "expired" as const,
                    workspace: "/workspace/alpha",
                },
            ],
            instanceState: {
                ...state.readModel.instanceState,
                alpha: {
                    ...state.readModel.instanceState.alpha!,
                    toolCalls: [
                        alphaCall,
                        {
                            ...alphaCall,
                            callId: "call-expired",
                            ctxId: "ctx-expired",
                            toolName: "expired_tool",
                        },
                    ],
                },
            },
        },
    };

    const view = render(<ToolCalls
        state={expiredContextState}
        store={{ queueContextMessage: vi.fn() } as unknown as WebStore}
    />);

    expect(screen.getByLabelText("Context status")).toHaveValue("active");
    expect(screen.queryByRole("option", { name: "ctx-expired" })).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Context status"), {
        target: { value: "expired" },
    });

    expect(screen.getByRole("option", { name: "ctx-expired" })).toBeInTheDocument();
    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(1);
    expect(within(view.container.querySelector(".activity-feed")!).getByText("expired_tool")).toBeInTheDocument();
});

it("paginates queued Comments in groups of eight", () => {
    const commentState: WebState = {
        ...state,
        readModel: {
            ...state.readModel,
            instanceState: {
                ...state.readModel.instanceState,
                alpha: {
                    ...state.readModel.instanceState.alpha!,
                    contextMessages: Array.from({ length: 9 }, (_, index) => ({
                        createdAt: `2026-07-31T09:${String(index).padStart(2, "0")}:00Z`,
                        ctxId: "ctx-alpha",
                        id: `message-${index}`,
                        instance: "alpha",
                        status: "pending" as const,
                        text: `Comment ${index}`,
                    })),
                },
            },
        },
    };

    render(<ToolCalls
        state={commentState}
        store={{ queueContextMessage: vi.fn() } as unknown as WebStore}
    />);

    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });

    const pagination = screen.getByRole("navigation", { name: "Queued Comments pagination" });
    expect(screen.getAllByText(/^Comment \d$/)).toHaveLength(8);
    expect(pagination).toHaveTextContent("Page 1 of 2");
    fireEvent.click(within(pagination).getByRole("button", { name: "Next page" }));
    expect(screen.getAllByText(/^Comment \d$/)).toHaveLength(1);
    expect(pagination).toHaveTextContent("Page 2 of 2");
});

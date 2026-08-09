import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { asInstanceName, createInitialControlReadModelState } from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { ToolCalls } from "../src/views/ToolCalls.js";
import type { WebState, WebStore } from "../src/state/WebStore.js";

const alphaCall = {
    callId: "call-alpha",
    completedAt: "2026-07-31T09:00:01Z",
    ctxId: "ctx-alpha",
    input: { command: "false" },
    inputSummary: '{"command":"false"}',
    instance: asInstanceName("alpha"),
    output: { exitCode: 1, stderr: "failed", stdout: "" },
    source: "mcp" as const,
    startedAt: "2026-07-31T09:00:00Z",
    status: "failed" as const,
    toolName: "bash_run",
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

    fireEvent.change(screen.getByLabelText("Instance"), {
        target: { value: "alpha" },
    });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });
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
    const details = screen.getByText("alpha · mcp · ctx-alpha").closest("details")!;
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

    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(100);
    const pagination = screen.getByRole("navigation", { name: "Tool calls pagination" });
    expect(pagination).toHaveTextContent("Page 1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(view.container.querySelectorAll(".activity-feed > li")).toHaveLength(51);
    expect(pagination).toHaveTextContent("Page 2 of 2");
});

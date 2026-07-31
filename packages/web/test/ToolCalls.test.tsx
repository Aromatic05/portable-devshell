import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { asInstanceName } from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { ToolCalls } from "../src/views/ToolCalls.js";
import type { WebState, WebStore } from "../src/state/WebStore.js";

const state: WebState = {
    approvals: {},
    connection: "online",
    contextMessages: {
        alpha: [
            {
                createdAt: "2026-07-31T09:05:00Z",
                ctxId: "ctx-alpha",
                id: "message-1",
                instance: "alpha",
                status: "pending",
                text: "Check the failing command.",
            },
        ],
    },
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
    logs: {},
    oauthApprovals: [],
    operations: {},
    partialFailures: {},
    todos: {},
    toolCalls: {
        alpha: [
            {
                callId: "call-alpha",
                completedAt: "2026-07-31T09:00:01Z",
                ctxId: "ctx-alpha",
                input: { command: "false" },
                inputSummary: '{"command":"false"}',
                instance: asInstanceName("alpha"),
                source: "mcp",
                startedAt: "2026-07-31T09:00:00Z",
                status: "failed",
                toolName: "bash_run",
            },
        ],
        beta: [
            {
                callId: "call-beta",
                completedAt: "2026-07-31T09:10:01Z",
                ctxId: "ctx-beta",
                inputSummary: '{"path":"README.md"}',
                instance: asInstanceName("beta"),
                source: "mcp",
                startedAt: "2026-07-31T09:10:00Z",
                status: "completed",
                toolName: "file_read",
            },
        ],
    },
};

it("filters structured tool calls by ctxId and queues a message for the selected Context", async () => {
    const queueContextMessage = vi.fn(async () => true);
    const store = { queueContextMessage } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    expect(screen.getByRole("heading", { name: "Tool Calls" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search"), {
        target: { value: "file_read" },
    });
    expect(
        screen.getByText("1 of 2 tool calls match active filters."),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByText("2 of 2 tool calls.")).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Instance"), {
        target: { value: "alpha" },
    });
    fireEvent.change(screen.getByLabelText("Context"), {
        target: { value: "context:ctx-alpha" },
    });
    expect(screen.getByText("Check the failing command.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Message"), {
        target: { value: "Retry after checking the environment." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
        expect(queueContextMessage).toHaveBeenCalledWith(
            "alpha",
            "ctx-alpha",
            "Retry after checking the environment.",
        ),
    );
});

it("clears Context synchronously when the selected instance changes", async () => {
    const queueContextMessage = vi.fn(async () => true);
    const store = { queueContextMessage } as unknown as WebStore;
    render(<ToolCalls state={state} store={store} />);

    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "alpha" } });
    fireEvent.change(screen.getByLabelText("Context"), { target: { value: "context:ctx-alpha" } });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Do not misroute" } });
    fireEvent.change(screen.getByLabelText("Instance"), { target: { value: "beta" } });

    expect(screen.getByLabelText("Context")).toHaveValue("all");
    expect(screen.queryByRole("button", { name: "Send message" })).not.toBeInTheDocument();
    expect(queueContextMessage).not.toHaveBeenCalled();
});

it("does not render large Tool Call details until the row is expanded", () => {
    const token = "large-output-token";
    const output = `${token}${"x".repeat(200_000)}`;
    const largeState: WebState = {
        ...state,
        toolCalls: {
            alpha: [{
                ...state.toolCalls.alpha![0]!,
                callId: "large-call",
                output,
            }],
        },
    };
    render(<ToolCalls state={largeState} store={{ queueContextMessage: vi.fn() } as unknown as WebStore} />);

    expect(screen.queryByText(new RegExp(token))).not.toBeInTheDocument();
    const details = document.querySelector("details")!;
    details.open = true;
    fireEvent(details, new Event("toggle"));
    expect(screen.getByText(new RegExp(token))).toBeInTheDocument();
});

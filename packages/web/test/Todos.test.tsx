import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { asInstanceName, createInitialControlReadModelState } from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { Todos } from "../src/views/Todos.js";
import type { WebState, WebStore } from "../src/state/WebStore.js";

it("identifies the exact instance and task before permanently deleting a Todo project", async () => {
    const state: WebState = {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            instances: [{ mcpEnabled: true, name: "alpha" }],
            instanceState: {
                alpha: {
                    approvals: [],
                    commentCalls: [],
                    contextMessages: [],
                    logs: [],
                    sequence: 0,
                    toolCalls: [],
                    todo: {
                        items: [{ content: "Ship", id: "ship", status: "in_progress" }],
                        revision: 3,
                        summary: { completed: 0, currentItemId: "ship", total: 1 },
                        taskId: "task-1",
                        title: "Release portable-devshell",
                    },
                },
            },
        },
    };
    const deleteTodo = vi.fn(async () => true);
    const store = { deleteTodo } as unknown as WebStore;

    render(<Todos state={state} store={store} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm delete" });
    expect(within(dialog).getByText(/Release portable-devshell/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/task-1/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/alpha/u)).toBeInTheDocument();
    expect(deleteTodo).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleteTodo).toHaveBeenCalledWith("alpha", "task-1"));
});

it("disables Todo deletion during a session-level operation", () => {
    const state: WebState = {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            instances: [{ mcpEnabled: true, name: "alpha" }],
            instanceState: {
                alpha: {
                    approvals: [],
                    commentCalls: [],
                    contextMessages: [],
                    logs: [],
                    sequence: 0,
                    toolCalls: [],
                    todo: {
                        items: [{ content: "Ship", id: "ship", status: "in_progress" }],
                        revision: 3,
                        summary: { completed: 0, currentItemId: "ship", total: 1 },
                        taskId: "task-1",
                        title: "Release portable-devshell",
                    },
                },
            },
        },
    };

    render(<Todos disabled state={state} store={{} as WebStore} />);

    expect(screen.getByRole("button", { name: "Delete project" })).toBeDisabled();
});

it("renders active Workspace Goals on the Todo page", () => {
    const state: WebState = {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            instances: [{ mcpEnabled: true, name: "alpha" }],
            instanceState: {
                alpha: {
                    approvals: [],
                    commentCalls: [],
                    contextMessages: [],
                    goals: [{
                        autoContinueExhausted: false,
                        continuationCount: 1,
                        continuationDue: false,
                        continuationDueAt: "2026-08-31T10:00:00.000Z",
                        continuationPending: false,
                        continuationUncertain: false,
                        createdAt: "2026-08-31T09:00:00.000Z",
                        goalId: "goal-visible",
                        lastAgentActivityAt: "2026-08-31T09:30:00.000Z",
                        lastProgressAt: "2026-08-31T09:30:00.000Z",
                        maxContinuations: 10,
                        objective: "Ship Workspace recovery",
                        revision: 4,
                        status: "active",
                        steps: [
                            { id: "inspect", status: "completed", text: "Inspect" },
                            { id: "fix", status: "active", text: "Fix" },
                        ],
                        updatedAt: "2026-08-31T09:30:00.000Z",
                        workspace: "/home/aromatic/Applications/OwnProject/portable-devshell",
                    }],
                    logs: [],
                    sequence: 0,
                    toolCalls: [],
                },
            },
        },
    };

    const { container } = render(<Todos state={state} store={{} as WebStore} />);
    const goal = container.querySelector('[data-goal-id="goal-visible"]');
    expect(goal).not.toBeNull();
    expect(goal).toHaveAttribute("data-goal-status", "active");
});

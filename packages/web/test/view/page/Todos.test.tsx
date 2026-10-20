import {
    act,
    fireEvent,
    render,
    screen,
    waitFor,
    within,
} from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { Todos } from "../../../src/view/page/Todos.js";
import { WebStore } from "../../../src/state/Store.js";
import {
    WebTestDomains,
    withWebDomains,
} from "../../support/DomainHarness.js";

function renderTodos(
    options: {
        disabled?: boolean;
        goals?: readonly unknown[];
        instances?: readonly unknown[];
        todo?: unknown;
    } = {},
) {
    const domains = new WebTestDomains();
    Object.assign(domains.goals, { load: async () => undefined });
    domains.setInstances(options.instances ?? []);
    if (options.todo !== undefined) domains.setTodo("alpha", options.todo);
    if (options.goals !== undefined) {
        domains.goals.patch({
            instances: {
                alpha: {
                    goals: [...options.goals],
                    lastSeq: 0,
                    status: "stopped",
                },
            },
        });
    }
    const store = new WebStore(domains.domains);
    return {
        domains,
        store,
        ...render(
            withWebDomains(
                domains,
                <Todos disabled={options.disabled} store={store} />,
            ),
        ),
    };
}

it("identifies the exact instance and task before permanently deleting a Todo project", async () => {
    const { store } = renderTodos({
        instances: [{ mcpEnabled: true, name: "alpha" }],
        todo: {
            items: [
                {
                    content: "Ship",
                    id: "ship",
                    status: "in_progress",
                },
            ],
            revision: 3,
            summary: {
                completed: 0,
                currentItemId: "ship",
                total: 1,
            },
            taskId: "task-1",
            title: "Release portable-devshell",
        },
    });
    const deleteTodo = vi.spyOn(store, "deleteTodo").mockResolvedValue(true);

    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm delete" });
    expect(
        within(dialog).getByText(/Release portable-devshell/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/task-1/u)).toBeInTheDocument();
    expect(within(dialog).getByText(/alpha/u)).toBeInTheDocument();
    expect(deleteTodo).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
        expect(deleteTodo).toHaveBeenCalledWith("alpha", "task-1"),
    );
});

it("shows current Todo work, checkpoint, blockers, and task steps for supervision", () => {
    renderTodos({
        instances: [{ mcpEnabled: true, name: "alpha" }],
        todo: {
            checkpoint: {
                blockers: ["Waiting for review"],
                next: "Run release checks",
                summary: "Implementation is ready for review.",
                updatedAt: "2026-09-14T10:00:00Z",
            },
            items: [
                {
                    content: "Ship",
                    id: "ship",
                    status: "in_progress",
                },
            ],
            revision: 3,
            summary: {
                completed: 0,
                currentItemId: "ship",
                total: 1,
            },
            taskId: "task-supervision",
            title: "Release supervision",
        },
    });

    expect(
        screen.getByText("Implementation is ready for review."),
    ).toBeInTheDocument();
    expect(screen.getByText("Run release checks")).toBeInTheDocument();
    expect(screen.getByText("Waiting for review")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Task steps"));
    expect(screen.getAllByText("Ship")).toHaveLength(2);
    expect(
        screen.getByText("in_progress", { selector: "span" }),
    ).toBeInTheDocument();
});

it("keeps failed Todo deletion in context and shows the error in the dialog", async () => {
    const { store } = renderTodos({
        instances: [{ mcpEnabled: true, name: "alpha" }],
        todo: {
            items: [
                {
                    content: "Ship",
                    id: "ship",
                    status: "in_progress",
                },
            ],
            revision: 3,
            summary: {
                completed: 0,
                currentItemId: "ship",
                total: 1,
            },
            taskId: "task-1",
            title: "Release portable-devshell",
        },
    });
    vi.spyOn(store, "state", "get").mockReturnValue({
        error: "Todo deletion failed.",
        operations: {},
    });
    const deleteTodo = vi.spyOn(store, "deleteTodo").mockResolvedValue(false);

    fireEvent.click(screen.getByRole("button", { name: "Delete project" }));
    fireEvent.click(
        within(
            screen.getByRole("dialog", { name: "Confirm delete" }),
        ).getByRole("button", { name: "Delete" }),
    );

    await waitFor(() => expect(deleteTodo).toHaveBeenCalledOnce());
    const dialog = screen.getByRole("dialog", { name: "Confirm delete" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
        "Todo deletion failed.",
    );
});

it("disables Todo deletion during a session-level operation", () => {
    renderTodos({
        disabled: true,
        instances: [{ mcpEnabled: true, name: "alpha" }],
        todo: {
            items: [
                {
                    content: "Ship",
                    id: "ship",
                    status: "in_progress",
                },
            ],
            revision: 3,
            summary: {
                completed: 0,
                currentItemId: "ship",
                total: 1,
            },
            taskId: "task-1",
            title: "Release portable-devshell",
        },
    });

    expect(
        screen.getByRole("button", { name: "Delete project" }),
    ).toBeDisabled();
});

it("renders active Workspace Goals on the Todo page", () => {
    const { container } = renderTodos({
        instances: [{ mcpEnabled: true, name: "alpha" }],
        goals: [
            {
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
                workspace:
                    "/home/aromatic/Applications/OwnProject/portable-devshell",
            },
        ],
    });

    const goal = container.querySelector('[data-goal-id="goal-visible"]');
    expect(goal).not.toBeNull();
    expect(goal).toHaveAttribute("data-goal-status", "active");
});

it("refreshes visible Todo state when the domain publishes a newer revision", async () => {
    const { domains } = renderTodos({
        instances: [{ mcpEnabled: true, name: "alpha" }],
        todo: {
            items: [
                { content: "Inspect", id: "inspect", status: "pending" },
            ],
            revision: 3,
            summary: { completed: 0, currentItemId: "inspect", total: 1 },
            taskId: "task-1",
            title: "Initial task",
        },
    });

    expect(screen.getByText("Initial task")).toBeInTheDocument();

    act(() => {
        domains.setTodo("alpha", {
            items: [
                { content: "Inspect", id: "inspect", status: "completed" },
                { content: "Ship", id: "ship", status: "in_progress" },
            ],
            revision: 4,
            summary: { completed: 1, currentItemId: "ship", total: 2 },
            taskId: "task-1",
            title: "Updated task",
        });
    });

    expect(await screen.findByText("Updated task")).toBeInTheDocument();
    expect(screen.queryByText("Initial task")).not.toBeInTheDocument();
    expect(
        screen.getByText(
            (_, element) =>
                element?.tagName === "STRONG" &&
                element.textContent?.includes("1/2 complete") === true,
        ),
    ).toBeInTheDocument();
});

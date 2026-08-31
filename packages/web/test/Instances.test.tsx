import { fireEvent, render, screen, within } from "@testing-library/react";
import { asInstanceName, createInitialControlReadModelState } from "@portable-devshell/shared/browser";
import { expect, it, vi } from "vitest";

import { Instances } from "../src/views/Instances.js";
import type { WebStore } from "../src/state/WebStore.js";

function reverseStore(availability: "offline" | "online"): WebStore {
    const online = availability === "online";
    return {
        state: {
            connection: "online",
            operations: {},
            readModel: {
                ...createInitialControlReadModelState(),
                instances: [{
                    mcpEnabled: true,
                    name: "reverse-mac",
                    snapshot: {
                        connectionState: online ? "connected" : "disconnected",
                        daemonState: online ? "running" : "stopped",
                        lastSeq: 1,
                        name: asInstanceName("reverse-mac"),
                        ready: online,
                        reverse: {
                            availability,
                            enrollmentState: "enrolled",
                            managementMode: "selfManaged",
                            ...(online ? { transport: "sse" as const } : {}),
                        },
                        status: online ? "ready" : "stopped",
                    },
                }],
            },
        },
        refreshInstance: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
    } as unknown as WebStore;
}

function localStore(status: "ready" | "stopped"): WebStore {
    const ready = status === "ready";
    return {
        state: {
            connection: "online",
            operations: {},
            readModel: {
                ...createInitialControlReadModelState(),
                instances: [{
                    mcpEnabled: true,
                    name: "local-one",
                    snapshot: {
                        connectionState: ready ? "connected" : "disconnected",
                        daemonState: ready ? "running" : "stopped",
                        lastSeq: 1,
                        name: asInstanceName("local-one"),
                        ready,
                        status,
                    },
                }],
            },
        },
        refreshInstance: vi.fn(async () => undefined),
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
    } as unknown as WebStore;
}

it("does not offer Start or Stop for an offline self-managed reverse instance", () => {
    render(<Instances store={reverseStore("offline")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByText(/self-managed.*offline/iu)).toBeInTheDocument();
});

it("does not offer Control lifecycle actions for an online self-managed reverse instance", () => {
    render(<Instances store={reverseStore("online")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.getByText(/self-managed.*remote machine/iu)).toBeInTheDocument();
});

it("starts a stopped local instance directly and marks the selected card", () => {
    const store = localStore("stopped");
    render(<Instances store={store} />);
    const card = screen.getByRole("button", { name: /local-one/u });
    fireEvent.click(card);

    expect(card).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Start" }));
    expect(store.start).toHaveBeenCalledWith("local-one");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("projects active Workspace Goals into the selected instance", () => {
    const store = localStore("ready");
    store.state.readModel.instanceState["local-one"] = {
        approvals: [],
        commentCalls: [],
        contextMessages: [],
        goals: [{
            autoContinueExhausted: false,
            continuationCount: 0,
            continuationDue: false,
            continuationDueAt: "2026-08-31T10:01:00.000Z",
            continuationPending: false,
            continuationUncertain: false,
            createdAt: "2026-08-31T10:00:00.000Z",
            goalId: "goal-visible",
            lastAgentActivityAt: "2026-08-31T10:00:00.000Z",
            lastProgressAt: "2026-08-31T10:00:00.000Z",
            maxContinuations: 10,
            objective: "Visible goal",
            revision: 2,
            status: "active",
            steps: [{ id: "work", status: "active", text: "Work" }],
            updatedAt: "2026-08-31T10:00:00.000Z",
            workspace: "/workspace/project",
        }],
        logs: [],
        sequence: 1,
        toolCalls: [],
    };
    const { container } = render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));
    const goal = container.querySelector('[data-goal-id="goal-visible"]');
    expect(goal).not.toBeNull();
    expect(goal).toHaveAttribute("data-goal-status", "active");
});

it("keeps confirmation for stopping a running local instance", () => {
    const store = localStore("ready");
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));

    expect(store.stop).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(dialog).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
    expect(store.stop).toHaveBeenCalledWith("local-one");
});

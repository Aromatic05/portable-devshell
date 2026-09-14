import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

it("keeps a failed Stop confirmation open and shows the failure in place", async () => {
    const store = localStore("ready");
    Object.assign(store.state, { error: "Stop failed." });
    store.stop = vi.fn(async () => false) as unknown as WebStore["stop"];
    render(<Instances store={store} />);
    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    fireEvent.click(within(screen.getByRole("dialog", { name: "Confirm stop" })).getByRole("button", { name: "Stop" }));

    await waitFor(() => expect(store.stop).toHaveBeenCalledOnce());
    const dialog = screen.getByRole("dialog", { name: "Confirm stop" });
    expect(within(dialog).getByRole("alert")).toHaveTextContent("Stop failed.");
});

it("shows instance refresh failures beside the selected detail instead of failing silently", async () => {
    const store = localStore("ready");
    store.refreshInstance = vi.fn(async () => { throw new Error("Instance refresh failed."); });
    render(<Instances store={store} />);

    fireEvent.click(screen.getByRole("button", { name: /local-one/u }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Instance refresh failed.");
    expect(screen.getByRole("heading", { name: "local-one", level: 3 })).toBeInTheDocument();
});

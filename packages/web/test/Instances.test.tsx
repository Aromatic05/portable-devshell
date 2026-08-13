import { fireEvent, render, screen } from "@testing-library/react";
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

it("does not offer Start or Stop for an offline self-managed reverse instance", () => {
    render(<Instances store={reverseStore("offline")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument();
    expect(screen.getByText(/self-managed.*offline/iu)).toBeInTheDocument();
});

it("offers Stop, but never Start, for an online self-managed reverse instance", () => {
    render(<Instances store={reverseStore("online")} />);
    fireEvent.click(screen.getByRole("button", { name: /reverse-mac/u }));

    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
});

import { render, screen, within } from "@testing-library/react";
import {
    asInstanceName,
    createInitialControlReadModelState,
} from "@portable-devshell/shared/browser";
import { expect, it } from "vitest";

import { WorkerDiagnostics } from "../../../src/view/page/Instances.js";
import { Overview } from "../../../src/view/page/Overview.js";
import type { WebState } from "../../../src/state/Store.js";
import {
    formatBytes,
    formatDuration,
    formatPercent,
} from "@portable-devshell/shared/browser";
import { overviewAlertRoute } from "../../../src/view/ReadModel.js";
import { presentWorker } from "../../../src/view/page/Instances.js";

it("formats resource boundaries without representing unavailable values as zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(undefined)).not.toBe(formatPercent(0));
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(90_000)).toBe("1d 1h");
    expect(formatBytes(undefined)).not.toBe(formatBytes(0));
});

it("keeps controller and partial alerts on Overview while routing instance alerts to Instances", () => {
    expect(overviewAlertRoute("controller.diskPressure")).toBe("#/overview");
    expect(overviewAlertRoute("controller.memoryPressure")).toBe("#/overview");
    expect(overviewAlertRoute("overview.partial")).toBe("#/overview");
    expect(overviewAlertRoute("instance.failed")).toBe("#/instances");
});

it("presents worker handshake metadata only when the server supplied it", () => {
    const worker = {
        capabilities: { cancel: true, streaming: true, tools: false },
        platform: {
            arch: "arm64",
            distribution: { id: "ubuntu", name: "Ubuntu", version: "24.04" },
            os: "linux",
            packageManager: "apt",
            shell: { executable: "/bin/zsh", kind: "zsh", version: "5.9" },
        },
        protocolVersion: 3,
        version: "1.2.3",
    };
    expect(presentWorker(worker)?.platform).toBe("linux / arm64");

    const { rerender } = render(<WorkerDiagnostics worker={worker} />);
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    rerender(<WorkerDiagnostics worker={undefined} />);
    expect(screen.queryByText("1.2.3")).not.toBeInTheDocument();
});

it("shows an Overview failure instead of an endless loading message", () => {
    const state: WebState = {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            failures: {
                overview: {
                    error: new Error("overview timed out"),
                    id: "overview",
                    key: "overview",
                },
            },
        },
    };

    render(<Overview state={state} />);

    expect(screen.getByText(/overview timed out/)).toBeInTheDocument();
});

it("links an Overview instance directly to its bookmarkable detail route", () => {
    const demo = asInstanceName("demo");
    const state: WebState = {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            overview: {
                activity: [],
                alerts: [],
                controller: { pid: 1, uptimeSeconds: 1 },
                counts: {
                    activeTodos: 0,
                    failedCalls24h: 0,
                    instancesAttention: 0,
                    instancesCritical: 0,
                    instancesReady: 1,
                    instancesTotal: 1,
                    pendingApprovals: 0,
                },
                generatedAt: "2026-09-16T00:00:00Z",
                health: "healthy",
                instances: [
                    {
                        mcpEnabled: true,
                        name: demo,
                        pendingApprovals: 0,
                        provider: "local",
                        snapshot: {
                            connectionState: "connected",
                            daemonState: "running",
                            lastSeq: 1,
                            name: demo,
                            ready: true,
                            status: "ready",
                        },
                    },
                ],
                todos: [],
            },
        },
    };

    render(<Overview state={state} />);

    expect(screen.getByRole("link", { name: "demo" })).toHaveAttribute(
        "href",
        "#/instances/demo",
    );
});

function overviewState(counts: {
    instancesAttention: number;
    instancesCritical: number;
    instancesTotal: number;
}): WebState {
    return {
        connection: "online",
        operations: {},
        readModel: {
            ...createInitialControlReadModelState(),
            overview: {
                activity: [],
                alerts: [],
                controller: { pid: 1, uptimeSeconds: 1 },
                counts: {
                    activeTodos: 0,
                    failedCalls24h: 0,
                    instancesAttention: counts.instancesAttention,
                    instancesCritical: counts.instancesCritical,
                    instancesReady: 0,
                    instancesTotal: counts.instancesTotal,
                    pendingApprovals: 0,
                },
                generatedAt: "2026-09-16T00:00:00Z",
                health: "healthy",
                instances: [],
                todos: [],
            },
        },
    };
}

it("separates the Instances total from attention and critical annotations", () => {
    render(
        <Overview
            state={overviewState({
                instancesAttention: 2,
                instancesCritical: 1,
                instancesTotal: 5,
            })}
        />,
    );

    const metrics = screen.getByLabelText("Operational summary");
    expect(within(metrics).getByText("5")).toBeInTheDocument();
    expect(within(metrics).getByText("2 attention")).toHaveClass(
        "tone-warning",
    );
    expect(within(metrics).getByText("1 critical")).toHaveClass("tone-danger");
});

it("omits zero instance attention and critical annotations", () => {
    render(
        <Overview
            state={overviewState({
                instancesAttention: 0,
                instancesCritical: 0,
                instancesTotal: 5,
            })}
        />,
    );

    const metrics = screen.getByLabelText("Operational summary");
    expect(within(metrics).queryByText(/attention/u)).not.toBeInTheDocument();
    expect(within(metrics).queryByText(/critical/u)).not.toBeInTheDocument();
});

it("renders the Alerts heading as plain text instead of a self-referential link", () => {
    render(
        <Overview
            state={overviewState({
                instancesAttention: 0,
                instancesCritical: 0,
                instancesTotal: 0,
            })}
        />,
    );

    expect(
        screen.getByRole("heading", { name: "Alerts" }),
    ).toBeInTheDocument();
    expect(
        screen.queryByRole("link", { name: "Alerts" }),
    ).not.toBeInTheDocument();
});

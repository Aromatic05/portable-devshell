import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";

import { WorkerDiagnostics } from "../src/components/diagnostics/WorkerDiagnostics.js";
import { Overview } from "../src/views/Overview.js";
import type { WebState } from "../src/state/WebStore.js";
import { formatBytes, formatDuration, formatPercent } from "../src/formatters/resources.js";
import { overviewAlertRoute } from "../src/selectors/readModel.js";
import { presentWorker } from "../src/selectors/workerPresentation.js";

it("formats resource boundaries without representing unavailable values as zero", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1024)).toBe("1 KiB");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(undefined)).toBe("Unavailable");
    expect(formatDuration(3660)).toBe("1h 1m");
    expect(formatDuration(90_000)).toBe("1d 1h");
    expect(formatBytes(undefined)).toBe("Unavailable");
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
        platform: { arch: "arm64", distribution: { id: "ubuntu", name: "Ubuntu", version: "24.04" }, os: "linux", packageManager: "apt", shell: { executable: "/bin/zsh", kind: "zsh", version: "5.9" } },
        protocolVersion: 3,
        version: "1.2.3",
    };
    expect(presentWorker(worker)?.platform).toBe("linux / arm64");
    expect(presentWorker(worker)?.capabilities).toContainEqual({ label: "Tools", value: "unavailable" });

    const { rerender } = render(<WorkerDiagnostics worker={worker} />);
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    rerender(<WorkerDiagnostics worker={undefined} />);
    expect(screen.getByText(/not connected \/ unavailable/)).toBeInTheDocument();
});


it("shows an Overview failure instead of an endless loading message", () => {
    const state: WebState = {
        approvals: {},
        connection: "online",
        contextMessages: {},
        instances: [],
        logs: {},
        oauthApprovals: [],
        operations: {},
        partialFailures: { overview: "overview timed out" },
        todos: {},
        toolCalls: {},
    };

    render(<Overview state={state} />);

    expect(screen.getByText("Overview could not be refreshed: overview timed out")).toHaveClass("error");
    expect(screen.queryByText("Loading operational overview…")).not.toBeInTheDocument();
});

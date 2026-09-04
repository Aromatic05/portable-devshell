const restorableDaemonStates = new Set(["running", "starting", "stale"]);

export function captureInstalledRuntimeState(runCli) {
    const status = runCli(["status"]);
    assertCliSuccess(status, "inspect current Control state");
    const statusOutput = String(status.stdout ?? "");
    const pidMatch = statusOutput.match(/^pid:\s+([1-9][0-9]*)\s*$/mu);
    const pid = pidMatch === null ? undefined : Number.parseInt(pidMatch[1], 10);
    if (!/^control:\s+running\s*$/mu.test(statusOutput)) {
        return {
            controlRunning: false,
            ...(pid === undefined ? {} : { pid }),
            instances: [],
        };
    }

    const overview = runCli(["overview"]);
    assertCliSuccess(overview, "capture running instances");
    let payload;
    try {
        payload = JSON.parse(String(overview.stdout ?? ""));
    } catch (error) {
        throw new Error(`Failed to capture running instances: overview returned invalid JSON. ${formatError(error)}`);
    }
    if (!Array.isArray(payload?.instances)) {
        throw new Error("Failed to capture running instances: overview result is missing instances.");
    }

    const instances = payload.instances
        .filter((entry) =>
            typeof entry?.name === "string" &&
            entry.name.length > 0 &&
            entry.snapshot?.reverse === undefined &&
            restorableDaemonStates.has(entry.snapshot?.daemonState)
        )
        .map((entry) => entry.name);

    return {
        controlRunning: true,
        ...(pid === undefined ? {} : { pid }),
        instances: [...new Set(instances)],
    };
}

export function restoreInstalledRuntimeState(runCli, state) {
    if (state.controlRunning !== true) return;

    assertCliSuccess(runCli(["start"]), "restart Control after installation");
    const failures = [];
    for (const instance of state.instances) {
        try {
            assertCliSuccess(
                runCli(["instance", "start", instance]),
                `restore instance ${instance}`,
            );
        } catch (error) {
            failures.push(error);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, `Failed to restore ${failures.length} instance(s) after installation.`);
    }
}

function assertCliSuccess(result, action) {
    if (result?.error === undefined && result?.status === 0) return;
    const detail = String(result?.stderr || result?.stdout || result?.error?.message || "unknown CLI failure").trim();
    throw new Error(`Failed to ${action}: ${detail}`);
}

function formatError(error) {
    return error instanceof Error ? error.message : String(error);
}

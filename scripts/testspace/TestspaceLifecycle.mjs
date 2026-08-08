export async function ensureInstanceReady(options) {
    const snapshot = await options.readSnapshot(options.instance);
    if (snapshot?.ready === true) {
        return { restarted: false, snapshot };
    }
    return {
        restarted: true,
        snapshot: await options.startInstance(options.instance),
    };
}

export async function ensureConnectorProcesses(targets, options) {
    const result = {};
    const changed = [];
    try {
        for (const target of targets) {
            const existingPid = await options.readPid(target);
            const running = options.isProcessAlive(existingPid);
            const health = running && options.readHealth !== undefined
                ? await options.readHealth(target)
                : undefined;
            const reusable = running && (
                options.readHealth === undefined || connectorHealthIsUsable(health)
            );
            if (reusable) {
                result[target.instance] = { pid: existingPid, restarted: false };
                continue;
            }
            const pid = running
                ? await requireRestartConnector(options)(target, existingPid)
                : await options.startConnector(target);
            changed.push({ pid, target });
            result[target.instance] = { pid, restarted: true };
        }
        return result;
    } catch (error) {
        const rollbackFailures = await rollbackChangedConnectors(changed, options);
        if (rollbackFailures.length > 0) {
            throw new AggregateError(
                [error instanceof Error ? error : new Error(String(error)), ...rollbackFailures],
                "Testspace connector startup failed and rollback was incomplete.",
            );
        }
        throw error;
    }
}

export async function waitForConnectorReady(target, pid, options) {
    const timeoutMs = options.timeoutMs ?? 5_000;
    const delay = options.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const deadline = Date.now() + timeoutMs;
    let lastHealth;
    while (Date.now() <= deadline) {
        if (!options.isProcessAlive(pid)) {
            throw new Error(`Testspace activity connector for ${target.instance} exited during startup.`);
        }
        lastHealth = await options.readHealth(target);
        if (connectorHealthIsUsable(lastHealth)) return lastHealth;
        if (connectorHealthIsFailed(lastHealth)) {
            throw new Error(
                lastHealth?.lastError ||
                `Testspace activity connector for ${target.instance} is ${lastHealth?.status ?? "unhealthy"}.`,
            );
        }
        await delay(25);
    }
    throw new Error(
        `Testspace activity connector for ${target.instance} did not become ready: ${JSON.stringify(lastHealth)}`,
    );
}

export async function readConnectorStatuses(targets, options) {
    const result = {};
    for (const target of targets) {
        const pid = await options.readPid(target);
        result[target.instance] = {
            health: await options.readHealth(target.healthFile),
            pid,
            running: options.isProcessAlive(pid),
        };
    }
    return result;
}

export function stopWorkerProcesses(targets) {
    const failures = [];
    const result = {};
    for (const target of targets) {
        try {
            result[target.instance] = target.stop();
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures, "Failed to stop all Testspace Worker processes.");
    }
    return result;
}

function connectorHealthIsUsable(health) {
    return health?.status === "active";
}

function connectorHealthIsFailed(health) {
    return health?.status === "degraded" ||
        health?.status === "error" ||
        health?.status === "unreadable";
}

function requireRestartConnector(options) {
    if (options.restartConnector !== undefined) return options.restartConnector;
    throw new Error("restartConnector is required to replace an unhealthy running connector.");
}

async function rollbackChangedConnectors(changed, options) {
    if (options.rollbackConnector === undefined) return [];
    const failures = [];
    for (const { pid, target } of [...changed].reverse()) {
        try {
            await options.rollbackConnector(target, pid);
        } catch (error) {
            failures.push(error instanceof Error ? error : new Error(String(error)));
        }
    }
    return failures;
}

import { createError, errorCodes } from "@portable-devshell/shared";

import type { InstanceSnapshot } from "../../instance/state/InstanceStateSnapshot.js";

export function normalizeLifecycleStatus(status: InstanceSnapshot["status"]): "failed" | "running" | "stale" | "stopped" {
    return status === "ready" ? "running" : status;
}

export function parseWorkerStatus(
    stdout: string,
    instanceName: string
): {
    daemonState: "running" | "stale" | "stopped";
    pid?: number;
    workspacePath?: string;
} {
    let parsed: unknown;

    try {
        parsed = JSON.parse(stdout) as unknown;
    } catch (error) {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            cause: error,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    const candidate = parsed as Record<string, unknown>;
    const state = candidate.state;

    if (state !== "running" && state !== "stale" && state !== "stopped") {
        throw createError({
            code: errorCodes.coreWorkerStatusFailed,
            message: `Worker status returned an unknown state for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                state: String(state),
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000)
            }
        });
    }

    return {
        daemonState: state,
        pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
        workspacePath: typeof candidate.workspace === "string" ? candidate.workspace : undefined
    };
}


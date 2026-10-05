import {
    createRemoteError,
    runtimeErrorCodes,
    type ConnectionState,
    type DaemonState,
    type InstanceSnapshot,
    type ProcessStatus,
} from "@portable-devshell/shared";

export interface InstanceProcessState {
    connectionState: ConnectionState;
    daemonState: DaemonState;
    lastErrorCode?: string;
    lastErrorMessage?: string;
    lastSeq: number;
    pid?: number;
    ready: boolean;
    status: ProcessStatus;
}

export function deriveProcessStatus(
    daemonState: DaemonState,
    connectionState: ConnectionState,
): ProcessStatus {
    if (daemonState === "failed" || connectionState === "failed") return "failed";
    if (daemonState === "stale") return "stale";
    if (daemonState === "stopped" || daemonState === "stopping") return "stopped";
    if (daemonState === "running" && connectionState === "connected") return "ready";
    return "running";
}

export function isReadyState(
    daemonState: DaemonState,
    connectionState: ConnectionState,
): boolean {
    return deriveProcessStatus(daemonState, connectionState) === "ready";
}

export function normalizeLifecycleStatus(
    status: InstanceSnapshot["status"],
): "failed" | "running" | "stale" | "stopped" {
    return status === "ready" ? "running" : status;
}

export function parseWorkerStatus(
    stdout: string,
    instanceName: string,
): {
    daemonState: "running" | "stale" | "stopped";
    pid?: number;
    workerSha256?: string;
} {
    let parsed: unknown;
    try {
        parsed = JSON.parse(stdout) as unknown;
    } catch (error) {
        throw createRemoteError({
            code: runtimeErrorCodes.workerStatusFailed,
            cause: error,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000),
            },
        });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw createRemoteError({
            code: runtimeErrorCodes.workerStatusFailed,
            message: `Worker status returned an invalid payload for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000),
            },
        });
    }
    const candidate = parsed as Record<string, unknown>;
    const state = candidate.state;
    if (state !== "running" && state !== "stale" && state !== "stopped") {
        throw createRemoteError({
            code: runtimeErrorCodes.workerStatusFailed,
            message: `Worker status returned an unknown state for instance ${instanceName}.`,
            retryable: false,
            details: {
                instance: instanceName,
                state: String(state),
                stdoutTail: stdout.length <= 4000 ? stdout : stdout.slice(-4000),
            },
        });
    }
    return {
        daemonState: state,
        pid: typeof candidate.pid === "number" ? candidate.pid : undefined,
        workerSha256:
            typeof candidate.workerSha256 === "string"
                ? candidate.workerSha256
                : undefined,
    };
}

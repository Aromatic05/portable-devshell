import {
    asInstanceName,
    type InstanceSnapshot,
    OperationalOverviewActivity,
    OperationalOverviewAlert,
    OperationalOverviewInstance,
    type OperationalOverviewWorker,
} from "@portable-devshell/shared";

import type {
    InstanceDescriptor,
} from "@portable-devshell/core";
import {
    createCollectionFailure,
    createRecentFailureAlert,
    createSnapshotAlerts,
    selectOperationalActivity,
} from "./Policy.js";

const failureWindowMs = 24 * 60 * 60 * 1_000;

export interface OperationalOverviewInstanceCollection {
    activity: OperationalOverviewActivity[];
    alerts: OperationalOverviewAlert[];
    failedCalls24h: number;
    instance: OperationalOverviewInstance;
}

export class OperationalOverviewInstanceCollector {
    readonly #activityLimit: number;

    constructor(options?: {
        activityLimit?: number;
    }) {
        this.#activityLimit = options?.activityLimit ?? 20;
    }

    async collect(
        descriptor: InstanceDescriptor,
        now: Date,
    ): Promise<OperationalOverviewInstanceCollection> {
        const snapshot = readSnapshot(descriptor);
        const alerts = createSnapshotAlerts(snapshot.name, snapshot);
                descriptor.worker.readToolCalls({
                    includeInput: false,
                    includeOutput: false,
                    limit: Math.max(1, this.#activityLimit),
                    maxBytes: 128 * 1024,
                }),
                descriptor.worker.readToolCallFailureSummary(
                    now.getTime() - failureWindowMs,
                    now.getTime(),
                ),
        const calls =
            callsResult.status === "fulfilled" ? callsResult.value : [];
        const toolCallFailure =
            callsResult.status === "rejected"
                ? callsResult.reason
                : failureResult.status === "rejected"
                  ? failureResult.reason
                  : undefined;
        if (toolCallFailure !== undefined) {
            alerts.push(
                createCollectionFailure(
                    snapshot.name,
                    "tool call history",
                    toolCallFailure,
                ),
            );
        }
        const recentFailure = createRecentFailureAlert(
            snapshot.name,
            failureResult.status === "fulfilled"
                ? failureResult.value
                : { count: 0 },
        );
        if (recentFailure.alert !== undefined) {
            alerts.push(recentFailure.alert);
        }

        return {
            activity: selectOperationalActivity(calls, this.#activityLimit),
            alerts,
            failedCalls24h: recentFailure.count,
            instance: {
                mcpEnabled: descriptor.mcpEnabled,
                name: snapshot.name,
                provider: descriptor.provider,
                snapshot,
                ...(descriptor.worker.handshake === undefined
                    ? {}
                    : {
                          worker: toOperationalWorker(
                              descriptor.worker.handshake,
                          ),
                      }),
            },
        };
    }
}

function toOperationalWorker(
    handshake: NonNullable<InstanceDescriptor["worker"]["handshake"]>,
): OperationalOverviewWorker {
    return {
        capabilities: { ...handshake.capabilities },
        platform: {
            arch: handshake.platform.arch,
            ...(handshake.platform.distribution === undefined
                ? {}
                : { distribution: { ...handshake.platform.distribution } }),
            os: handshake.platform.os,
            ...(handshake.platform.packageManager === undefined
                ? {}
                : { packageManager: handshake.platform.packageManager }),
            ...(handshake.platform.shell === undefined
                ? {}
                : { shell: { ...handshake.platform.shell } }),
        },
        protocolVersion: handshake.protocolVersion,
        version: handshake.workerVersion,
    };
}

function readSnapshot(descriptor: InstanceDescriptor): InstanceSnapshot {
    try {
        return descriptor.worker.snapshot();
    } catch (error) {
        const name = asInstanceName(descriptor.name);
        const failure = createCollectionFailure(
            name,
            "instance snapshot",
            error,
        );
        return {
            connectionState: "failed",
            daemonState: "failed",
            lastErrorMessage: failure.detail,
            lastSeq: 0,
            name,
            ready: false,
            status: "failed",
        };
    }
}

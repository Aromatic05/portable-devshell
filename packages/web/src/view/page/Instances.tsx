import { useRef, useState } from "react";

import type {
    ArtifactShareResult,
    ArtifactTransferRecord,
    JsonValue,
    OperationalOverviewWorker,
} from "@portable-devshell/shared/browser";
import {
    formatBytes,
    formatDuration,
    isArtifactTransferTerminal,
} from "@portable-devshell/shared/browser";

import { ConfirmationDialog } from "../component/Confirm.js";
import type { WebStore } from "../../state/Store.js";
import { InstanceCreate } from "./InstancesCreate.js";

export function Instances({
    disabled = false,
    store,
}: {
    disabled?: boolean;
    store: WebStore;
}) {
    const state = store.state;
    const model = state.readModel;
    const [selected, setSelected] = useState<string>();
    const [confirmation, setConfirmation] = useState<{
        action: "Delete" | "Disable" | "Restart" | "Stop";
        instance: string;
    }>();
    const [confirmationFailure, setConfirmationFailure] = useState<string>();
    const [detailFailure, setDetailFailure] = useState<string>();
    const [refreshingInstance, setRefreshingInstance] = useState<string>();
    const [lifecycleFailure, setLifecycleFailure] = useState<string>();
    const [creating, setCreating] = useState(false);
    const [createNotice, setCreateNotice] = useState<string>();
    const [artifactConfirmation, setArtifactConfirmation] = useState<
        { kind: "share"; id: string } | { kind: "transfer"; id: string }
    >();
    const [artifactFailure, setArtifactFailure] = useState<string>();
    const refreshGeneration = useRef(0);
    const selectedRef = useRef<string>();
    selectedRef.current = selected;
    const entry = model.instances.find(({ name }) => name === selected);
    const selectedWorker = model.overview?.instances.find(
        ({ name }) => name === entry?.name,
    )?.worker;
    const operation = confirmationOperation(confirmation);
    const interactive = state.connection === "online" && !disabled;
    const selfManaged =
        entry?.snapshot.reverse?.managementMode === "selfManaged";
    const lifecycleAction =
        entry === undefined
            ? undefined
            : selfManaged
              ? undefined
              : entry.snapshot.status === "stopped"
                ? "Start"
                : "Stop";
    const enabled =
        entry === undefined
            ? undefined
            : readInstanceEnabled(model.configView, entry.name);
    const artifactActivity =
        entry === undefined
            ? undefined
            : projectArtifactActivity(
                  entry.name,
                  model.artifactShares,
                  model.artifactTransfers,
              );

    return (
        <section className="instances-view">
            <div className="instances-heading">
                <h2>Instances</h2>
                <button
                    className="primary"
                    disabled={!interactive || creating}
                    onClick={() => {
                        refreshGeneration.current += 1;
                        selectedRef.current = undefined;
                        setSelected(undefined);
                        setCreating(true);
                        setCreateNotice(undefined);
                    }}
                    type="button"
                >
                    New instance
                </button>
            </div>
            {createNotice === undefined ? null : (
                <p className="notice" role="status">
                    {createNotice}
                </p>
            )}
            {creating ? (
                <InstanceCreate
                    disabled={!interactive}
                    onCancel={() => setCreating(false)}
                    onCreated={(enrollment) => {
                        setCreating(false);
                        setCreateNotice(
                            enrollment ?? "Instance created successfully.",
                        );
                    }}
                    store={store}
                />
            ) : (
                <>
                    {model.instances.length === 0 ? (
                        <p className="empty">No instances are available.</p>
                    ) : (
                        <div
                            className={`instances${entry === undefined ? "" : " has-selection"}`}
                        >
                            {model.instances.map((item) => (
                                <button
                                    aria-pressed={selected === item.name}
                                    className={`instance card${selected === item.name ? " selected" : ""}`}
                                    key={item.name}
                                    onClick={() => {
                                        const generation =
                                            ++refreshGeneration.current;
                                        selectedRef.current = item.name;
                                        setSelected(item.name);
                                        setDetailFailure(undefined);
                                        setLifecycleFailure(undefined);
                                        setRefreshingInstance(item.name);
                                        void store
                                            .refreshInstance(item.name)
                                            .catch((error: unknown) => {
                                                if (
                                                    refreshGeneration.current ===
                                                        generation &&
                                                    selectedRef.current ===
                                                        item.name
                                                ) {
                                                    setDetailFailure(
                                                        error instanceof Error
                                                            ? error.message
                                                            : "Instance details could not be refreshed.",
                                                    );
                                                }
                                            })
                                            .finally(() => {
                                                if (
                                                    refreshGeneration.current ===
                                                    generation
                                                ) {
                                                    setRefreshingInstance(
                                                        (current) =>
                                                            current ===
                                                            item.name
                                                                ? undefined
                                                                : current,
                                                    );
                                                }
                                            });
                                    }}
                                >
                                    <strong>{item.name}</strong>
                                    <span>
                                        {item.snapshot.status} ·{" "}
                                        {item.snapshot.connectionState}
                                    </span>
                                    <WorkerSummary
                                        worker={
                                            model.overview?.instances.find(
                                                ({ name }) =>
                                                    name === item.name,
                                            )?.worker
                                        }
                                    />
                                </button>
                            ))}
                        </div>
                    )}
                    {entry === undefined ? null : (
                        <article className="detail">
                            <button
                                className="back"
                                onClick={() => {
                                    refreshGeneration.current += 1;
                                    selectedRef.current = undefined;
                                    setSelected(undefined);
                                    setDetailFailure(undefined);
                                    setLifecycleFailure(undefined);
                                }}
                            >
                                Back to instances
                            </button>
                            <h3>{entry.name}</h3>
                            {refreshingInstance === entry.name ? (
                                <p className="hint" role="status">
                                    Refreshing instance details…
                                </p>
                            ) : null}
                            {detailFailure === undefined ? null : (
                                <p className="error" role="alert">
                                    {detailFailure}
                                </p>
                            )}
                            <p>
                                Runtime: {entry.snapshot.status}; daemon:{" "}
                                {entry.snapshot.daemonState}; sequence:{" "}
                                {entry.snapshot.lastSeq}
                            </p>
                            {selfManaged ? (
                                <p className="hint">
                                    Self-managed reverse worker ·{" "}
                                    {entry.snapshot.reverse?.availability ??
                                        "unknown"}
                                    {entry.snapshot.reverse?.transport ===
                                    undefined
                                        ? ""
                                        : ` · ${entry.snapshot.reverse.transport}`}
                                    {
                                        " · Lifecycle is managed on the remote machine."
                                    }
                                </p>
                            ) : null}
                            <WorkerDiagnostics worker={selectedWorker} />
                            {artifactActivity === undefined ? null : (
                                <ArtifactActivity
                                    activity={artifactActivity}
                                    disabled={!interactive}
                                    failure={artifactFailure}
                                    onCancelTransfer={(transferId) => {
                                        setArtifactFailure(undefined);
                                        setArtifactConfirmation({
                                            id: transferId,
                                            kind: "transfer",
                                        });
                                    }}
                                    onRefresh={() => {
                                        setArtifactFailure(undefined);
                                        void store
                                            .refreshArtifacts()
                                            .catch((error: unknown) =>
                                                setArtifactFailure(
                                                    error instanceof Error
                                                        ? error.message
                                                        : "Artifact activity could not be refreshed.",
                                                ),
                                            );
                                    }}
                                    onRevokeShare={(shareId) => {
                                        setArtifactFailure(undefined);
                                        setArtifactConfirmation({
                                            id: shareId,
                                            kind: "share",
                                        });
                                    }}
                                    operations={state.operations}
                                />
                            )}
                            <div className="actions">
                                <button
                                    disabled={
                                        !interactive ||
                                        refreshingInstance === entry.name
                                    }
                                    onClick={() => {
                                        const generation =
                                            ++refreshGeneration.current;
                                        setDetailFailure(undefined);
                                        setRefreshingInstance(entry.name);
                                        void store
                                            .refreshInstance(entry.name)
                                            .catch((error: unknown) => {
                                                if (
                                                    refreshGeneration.current ===
                                                        generation &&
                                                    selectedRef.current ===
                                                        entry.name
                                                ) {
                                                    setDetailFailure(
                                                        error instanceof Error
                                                            ? error.message
                                                            : "Instance details could not be refreshed.",
                                                    );
                                                }
                                            })
                                            .finally(() => {
                                                if (
                                                    refreshGeneration.current ===
                                                    generation
                                                )
                                                    setRefreshingInstance(
                                                        undefined,
                                                    );
                                            });
                                    }}
                                    type="button"
                                >
                                    Refresh
                                </button>
                                {lifecycleAction === undefined ? null : (
                                    <button
                                        className={
                                            lifecycleAction === "Start"
                                                ? "primary"
                                                : "danger"
                                        }
                                        disabled={
                                            !interactive ||
                                            state.operations[
                                                `start:${entry.name}`
                                            ] !== undefined ||
                                            state.operations[
                                                `stop:${entry.name}`
                                            ] !== undefined
                                        }
                                        onClick={() => {
                                            if (lifecycleAction === "Start") {
                                                setLifecycleFailure(undefined);
                                                void store
                                                    .start(entry.name)
                                                    .then((succeeded) => {
                                                        if (
                                                            !succeeded &&
                                                            selectedRef.current ===
                                                                entry.name
                                                        ) {
                                                            setLifecycleFailure(
                                                                store.state
                                                                    .error ??
                                                                    `${entry.name} could not be started.`,
                                                            );
                                                        }
                                                    });
                                                return;
                                            }
                                            setConfirmationFailure(undefined);
                                            setConfirmation({
                                                action: "Stop",
                                                instance: entry.name,
                                            });
                                        }}
                                    >
                                        {lifecycleAction === "Start" &&
                                        state.operations[
                                            `start:${entry.name}`
                                        ] !== undefined
                                            ? "Starting…"
                                            : lifecycleAction}
                                    </button>
                                )}
                                {selfManaged ||
                                entry.snapshot.status === "stopped" ? null : (
                                    <button
                                        disabled={
                                            !interactive ||
                                            state.operations[
                                                `restart:${entry.name}`
                                            ] !== undefined
                                        }
                                        onClick={() => {
                                            setConfirmationFailure(undefined);
                                            setConfirmation({
                                                action: "Restart",
                                                instance: entry.name,
                                            });
                                        }}
                                        type="button"
                                    >
                                        Restart
                                    </button>
                                )}
                                {enabled === undefined ? null : enabled ? (
                                    <button
                                        disabled={
                                            !interactive ||
                                            state.operations[
                                                `enabled:${entry.name}`
                                            ] !== undefined
                                        }
                                        onClick={() => {
                                            setConfirmationFailure(undefined);
                                            setConfirmation({
                                                action: "Disable",
                                                instance: entry.name,
                                            });
                                        }}
                                        type="button"
                                    >
                                        Disable
                                    </button>
                                ) : (
                                    <button
                                        disabled={
                                            !interactive ||
                                            state.operations[
                                                `enabled:${entry.name}`
                                            ] !== undefined
                                        }
                                        onClick={() => {
                                            setLifecycleFailure(undefined);
                                            void store
                                                .setInstanceEnabled(
                                                    entry.name,
                                                    true,
                                                )
                                                .then((succeeded) => {
                                                    if (!succeeded)
                                                        setLifecycleFailure(
                                                            store.state.error ??
                                                                `${entry.name} could not be enabled.`,
                                                        );
                                                });
                                        }}
                                        type="button"
                                    >
                                        Enable
                                    </button>
                                )}
                                <button
                                    className="danger"
                                    disabled={
                                        !interactive ||
                                        state.operations[
                                            `delete:${entry.name}`
                                        ] !== undefined
                                    }
                                    onClick={() => {
                                        setConfirmationFailure(undefined);
                                        setConfirmation({
                                            action: "Delete",
                                            instance: entry.name,
                                        });
                                    }}
                                    type="button"
                                >
                                    Delete
                                </button>
                            </div>
                            {lifecycleFailure === undefined ? null : (
                                <p className="error" role="alert">
                                    {lifecycleFailure}
                                </p>
                            )}
                        </article>
                    )}
                </>
            )}
            {confirmation === undefined ? null : (
                <ConfirmationDialog
                    actionLabel={confirmation.action}
                    busy={
                        operation !== undefined &&
                        state.operations[operation] !== undefined
                    }
                    description={`${confirmation.action} ${confirmation.instance}?`}
                    disabled={!interactive}
                    error={confirmationFailure}
                    variant={
                        confirmation.action === "Restart"
                            ? "default"
                            : "destructive"
                    }
                    onCancel={() => {
                        setConfirmationFailure(undefined);
                        setConfirmation(undefined);
                    }}
                    onConfirm={() => {
                        setConfirmationFailure(undefined);
                        const request =
                            confirmation.action === "Stop"
                                ? store.stop(confirmation.instance)
                                : confirmation.action === "Restart"
                                  ? store.restart(confirmation.instance)
                                  : confirmation.action === "Disable"
                                    ? store.setInstanceEnabled(
                                          confirmation.instance,
                                          false,
                                      )
                                    : store.deleteInstance(
                                          confirmation.instance,
                                      );
                        void request.then((succeeded) => {
                            if (succeeded) {
                                if (confirmation.action === "Delete") {
                                    refreshGeneration.current += 1;
                                    selectedRef.current = undefined;
                                    setSelected(undefined);
                                }
                                setConfirmation(undefined);
                            } else {
                                setConfirmationFailure(
                                    store.state.error ??
                                        `${confirmation.instance} action failed.`,
                                );
                            }
                        });
                    }}
                />
            )}
            {artifactConfirmation === undefined ? null : (
                <ConfirmationDialog
                    actionLabel={
                        artifactConfirmation.kind === "share"
                            ? "Revoke"
                            : "Cancel transfer"
                    }
                    busy={
                        state.operations[
                            artifactConfirmation.kind === "share"
                                ? `artifact:revoke:${artifactConfirmation.id}`
                                : `artifact:cancel:${artifactConfirmation.id}`
                        ] !== undefined
                    }
                    description={
                        artifactConfirmation.kind === "share"
                            ? `Revoke artifact share ${shortId(artifactConfirmation.id)}? Existing download links will stop working.`
                            : `Cancel artifact transfer ${shortId(artifactConfirmation.id)}?`
                    }
                    disabled={!interactive}
                    error={artifactFailure}
                    variant="destructive"
                    onCancel={() => {
                        setArtifactFailure(undefined);
                        setArtifactConfirmation(undefined);
                    }}
                    onConfirm={() => {
                        const current = artifactConfirmation;
                        setArtifactFailure(undefined);
                        const request =
                            current.kind === "share"
                                ? store.revokeArtifactShare(current.id)
                                : store.cancelArtifactTransfer(current.id);
                        void request.then((succeeded) => {
                            if (succeeded) {
                                setArtifactConfirmation(undefined);
                            } else {
                                setArtifactFailure(
                                    store.state.error ??
                                        `Artifact ${current.kind === "share" ? "share" : "transfer"} action failed.`,
                                );
                            }
                        });
                    }}
                />
            )}
        </section>
    );
}

interface ArtifactActivityProjection {
    active: number;
    shares: ArtifactShareResult[];
    transfers: ArtifactTransferRecord[];
}

function projectArtifactActivity(
    instance: string,
    shares: readonly ArtifactShareResult[],
    transfers: readonly ArtifactTransferRecord[],
): ArtifactActivityProjection {
    const instanceShares = shares
        .filter((share) => share.source.instance === instance)
        .slice(0, 3);
    const instanceTransfers = transfers
        .filter(
            (transfer) =>
                transfer.source.instance === instance ||
                transfer.target.instance === instance,
        )
        .slice(0, 5);
    return {
        active:
            instanceShares.filter((share) => share.state === "active").length +
            instanceTransfers.filter(
                (transfer) => !isArtifactTransferTerminal(transfer.status),
            ).length,
        shares: instanceShares,
        transfers: instanceTransfers,
    };
}

function ArtifactActivity({
    activity,
    disabled,
    failure,
    onCancelTransfer,
    onRefresh,
    onRevokeShare,
    operations,
}: {
    activity: ArtifactActivityProjection;
    disabled: boolean;
    failure?: string;
    onCancelTransfer(transferId: string): void;
    onRefresh(): void;
    onRevokeShare(shareId: string): void;
    operations: Record<string, "pending">;
}) {
    return (
        <section aria-label="Artifact activity" className="artifact-activity">
            <div className="artifact-activity-heading">
                <div>
                    <h4>Artifact activity</h4>
                    <span className="hint">
                        shares={activity.shares.length} · transfers=
                        {activity.transfers.length} · active={activity.active}
                    </span>
                </div>
                <button disabled={disabled} onClick={onRefresh} type="button">
                    Refresh artifacts
                </button>
            </div>
            {failure === undefined ? null : (
                <p className="error" role="alert">
                    {failure}
                </p>
            )}
            {activity.shares.length === 0 && activity.transfers.length === 0 ? (
                <p className="empty">No active or recent artifact activity.</p>
            ) : null}
            {activity.shares.map((share) => {
                const remainingSeconds = Math.max(
                    0,
                    Math.ceil((share.expiresAtMs - Date.now()) / 1000),
                );
                return (
                    <article className="artifact-row" key={share.shareId}>
                        <div>
                            <strong>
                                Share {shortId(share.shareId)} ·{" "}
                                {share.downloadName}
                            </strong>
                            <span>
                                {share.state} · {formatBytes(share.bytes)} ·
                                expires {formatDuration(remainingSeconds)}
                            </span>
                            <span>{artifactSourceLabel(share.source)}</span>
                        </div>
                        {share.state === "active" ? (
                            <button
                                className="danger"
                                disabled={
                                    disabled ||
                                    operations[
                                        `artifact:revoke:${share.shareId}`
                                    ] !== undefined
                                }
                                onClick={() => onRevokeShare(share.shareId)}
                                type="button"
                            >
                                Revoke share
                            </button>
                        ) : null}
                    </article>
                );
            })}
            {activity.transfers.map((transfer) => {
                const progress =
                    transfer.totalBytes === undefined
                        ? formatBytes(transfer.transferredBytes)
                        : `${formatBytes(transfer.transferredBytes)} / ${formatBytes(transfer.totalBytes)}`;
                const cancellable =
                    !isArtifactTransferTerminal(transfer.status) &&
                    transfer.status !== "cancelling";
                return (
                    <article className="artifact-row" key={transfer.transferId}>
                        <div>
                            <strong>
                                Transfer {shortId(transfer.transferId)} ·{" "}
                                {transfer.status}
                            </strong>
                            <span>{progress}</span>
                            <span>
                                {artifactSourceLabel(transfer.source)} →{" "}
                                {artifactTargetLabel(transfer.target)}
                            </span>
                            {transfer.failure === undefined ? null : (
                                <span className="error">
                                    {transfer.failure.code}:{" "}
                                    {transfer.failure.message}
                                </span>
                            )}
                        </div>
                        {cancellable ? (
                            <button
                                className="danger"
                                disabled={
                                    disabled ||
                                    operations[
                                        `artifact:cancel:${transfer.transferId}`
                                    ] !== undefined
                                }
                                onClick={() =>
                                    onCancelTransfer(transfer.transferId)
                                }
                                type="button"
                            >
                                Cancel transfer
                            </button>
                        ) : null}
                    </article>
                );
            })}
        </section>
    );
}

function artifactSourceLabel(source: ArtifactShareResult["source"]): string {
    if (source.handle !== undefined)
        return `${source.instance} · handle=${shortId(source.handle)}`;
    return `${source.instance} · workspace=${source.workspace ?? "-"} · path=${source.path ?? "-"}`;
}

function artifactTargetLabel(target: ArtifactTransferRecord["target"]): string {
    return `${target.instance} · workspace=${target.workspace ?? "-"} · path=${target.path}`;
}

function shortId(value: string): string {
    return value.length <= 8 ? value : value.slice(0, 8);
}

function confirmationOperation(
    confirmation:
        | {
              action: "Delete" | "Disable" | "Restart" | "Stop";
              instance: string;
          }
        | undefined,
): string | undefined {
    if (confirmation === undefined) return undefined;
    if (confirmation.action === "Disable")
        return `enabled:${confirmation.instance}`;
    return `${confirmation.action.toLowerCase()}:${confirmation.instance}`;
}

function readInstanceEnabled(
    configView: Record<string, JsonValue> | undefined,
    instance: string,
): boolean | undefined {
    const instances = configView?.instances;
    if (!Array.isArray(instances)) return undefined;
    for (const value of instances) {
        if (typeof value !== "object" || value === null || Array.isArray(value))
            continue;
        const record = value as Record<string, JsonValue>;
        if (record.name === instance && typeof record.enabled === "boolean")
            return record.enabled;
    }
    return undefined;
}

export interface WorkerPresentation {
    capabilities: Array<{ label: string; value: string }>;
    distribution: string;
    packageManager: string;
    platform: string;
    protocol: string;
    shell: string;
    version: string;
}

export function presentWorker(
    worker: OperationalOverviewWorker | undefined,
): WorkerPresentation | undefined {
    if (worker === undefined) return undefined;
    const distribution = worker.platform.distribution;
    const shell = worker.platform.shell;
    return {
        capabilities: [
            {
                label: "Tools",
                value: worker.capabilities.tools ? "available" : "unavailable",
            },
            {
                label: "Streaming",
                value: worker.capabilities.streaming
                    ? "available"
                    : "unavailable",
            },
            {
                label: "Cancel",
                value: worker.capabilities.cancel ? "available" : "unavailable",
            },
        ],
        distribution:
            distribution === undefined
                ? "Unavailable"
                : `${distribution.name} ${distribution.version ?? ""}`.trim(),
        packageManager: worker.platform.packageManager ?? "Unavailable",
        platform: `${worker.platform.os} / ${worker.platform.arch}`,
        protocol: String(worker.protocolVersion),
        shell:
            shell === undefined
                ? "Unavailable"
                : `${shell.kind} ${shell.version} (${shell.executable})`,
        version: worker.version,
    };
}

export function WorkerSummary({
    worker,
}: {
    worker: OperationalOverviewWorker | undefined;
}) {
    const presentation = presentWorker(worker);
    return presentation === undefined ? (
        <span>Worker: not connected / unavailable</span>
    ) : (
        <span>
            Worker {presentation.version} · protocol {presentation.protocol} ·{" "}
            {presentation.platform}
        </span>
    );
}

export function WorkerDiagnostics({
    worker,
}: {
    worker: OperationalOverviewWorker | undefined;
}) {
    const presentation = presentWorker(worker);
    if (presentation === undefined) {
        return (
            <section className="worker-diagnostics">
                <h4>Worker diagnostics</h4>
                <p className="empty">
                    Worker handshake is not connected / unavailable.
                </p>
            </section>
        );
    }
    return (
        <section className="worker-diagnostics">
            <h4>Worker diagnostics</h4>
            <dl className="diagnostic-list">
                <Diagnostic label="Version" value={presentation.version} />
                <Diagnostic label="Protocol" value={presentation.protocol} />
                <Diagnostic
                    label="OS / architecture"
                    value={presentation.platform}
                />
                <Diagnostic
                    label="Distribution"
                    value={presentation.distribution}
                />
                <Diagnostic
                    label="Package manager"
                    value={presentation.packageManager}
                />
                <Diagnostic label="Shell" value={presentation.shell} />
                {presentation.capabilities.map((capability) => (
                    <Diagnostic
                        key={capability.label}
                        label={capability.label}
                        value={capability.value}
                    />
                ))}
            </dl>
        </section>
    );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
    return (
        <div>
            <dt>{label}</dt>
            <dd>{value}</dd>
        </div>
    );
}

import { useRef, useState } from "react";

import type {
    JsonValue,
    OperationalOverviewWorker,
} from "@portable-devshell/shared/browser";

import { ConfirmationDialog } from "../component/Confirm.js";
import type { WebStore } from "../../state/Store.js";

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

    return (
        <section className="instances-view">
            <h2>Instances</h2>
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
                                const generation = ++refreshGeneration.current;
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
                                            selectedRef.current === item.name
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
                                            setRefreshingInstance((current) =>
                                                current === item.name
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
                                        ({ name }) => name === item.name,
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
                            {entry.snapshot.reverse?.availability ?? "unknown"}
                            {entry.snapshot.reverse?.transport === undefined
                                ? ""
                                : ` · ${entry.snapshot.reverse.transport}`}
                            {" · Lifecycle is managed on the remote machine."}
                        </p>
                    ) : null}
                    <WorkerDiagnostics worker={selectedWorker} />
                    <div className="actions">
                        <button
                            disabled={
                                !interactive ||
                                refreshingInstance === entry.name
                            }
                            onClick={() => {
                                const generation = ++refreshGeneration.current;
                                setDetailFailure(undefined);
                                setRefreshingInstance(entry.name);
                                void store
                                    .refreshInstance(entry.name)
                                    .catch((error: unknown) => {
                                        if (
                                            refreshGeneration.current ===
                                                generation &&
                                            selectedRef.current === entry.name
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
                                            setRefreshingInstance(undefined);
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
                                    state.operations[`start:${entry.name}`] !==
                                        undefined ||
                                    state.operations[`stop:${entry.name}`] !==
                                        undefined
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
                                                        store.state.error ??
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
                                state.operations[`start:${entry.name}`] !==
                                    undefined
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
                                        .setInstanceEnabled(entry.name, true)
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
                                state.operations[`delete:${entry.name}`] !==
                                    undefined
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
        </section>
    );
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

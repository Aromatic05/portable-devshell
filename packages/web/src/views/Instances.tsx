import { useState } from "react";

import { ConfirmationDialog } from "../components/ConfirmationDialog.js";
import {
    WorkerDiagnostics,
    WorkerSummary,
} from "../components/diagnostics/WorkerDiagnostics.js";
import type { WebStore } from "../state/WebStore.js";

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
        action: "Stop";
        instance: string;
    }>();
    const entry = model.instances.find(({ name }) => name === selected);
    const selectedWorker = model.overview?.instances.find(
        ({ name }) => name === entry?.name,
    )?.worker;
    const operation = confirmation === undefined
        ? undefined
        : `${confirmation.action.toLowerCase()}:${confirmation.instance}`;
    const interactive = state.connection === "online" && !disabled;
    const selfManaged = entry?.snapshot.reverse?.managementMode === "selfManaged";
    const lifecycleAction = entry === undefined
        ? undefined
        : selfManaged
            ? undefined
            : (entry.snapshot.status === "stopped" ? "Start" : "Stop");

    return <section className="instances-view">
        <h2>Instances</h2>
        {model.instances.length === 0
            ? <p className="empty">No instances are available.</p>
            : <div className={`instances${entry === undefined ? "" : " has-selection"}`}>
                {model.instances.map((item) => {
                    const goals = model.instanceState[item.name]?.goals ?? [];
                    return <button
                    aria-pressed={selected === item.name}
                    className={`instance card${selected === item.name ? " selected" : ""}`}
                    key={item.name}
                    onClick={() => {
                        setSelected(item.name);
                        void store.refreshInstance(item.name);
                    }}
                >
                    <strong>{item.name}</strong>
                    <span>{item.snapshot.status} · {item.snapshot.connectionState} · {goals.length} active goals</span>
                    <WorkerSummary worker={model.overview?.instances.find(
                        ({ name }) => name === item.name,
                    )?.worker} />
                </button>;
                })}
            </div>}
        {entry === undefined ? null : <article className="detail">
            <button className="back" onClick={() => setSelected(undefined)}>
                Back to instances
            </button>
            <h3>{entry.name}</h3>
            <p>
                Runtime: {entry.snapshot.status}; daemon: {entry.snapshot.daemonState};
                sequence: {entry.snapshot.lastSeq}
            </p>
            {selfManaged ? <p className="hint">
                Self-managed reverse worker · {entry.snapshot.reverse?.availability ?? "unknown"}
                {entry.snapshot.reverse?.transport === undefined ? "" : ` · ${entry.snapshot.reverse.transport}`}
                {" · Lifecycle is managed on the remote machine."}
            </p> : null}
            <WorkerDiagnostics worker={selectedWorker} />
            <h4>Workspace Goals</h4>
            {(model.instanceState[entry.name]?.goals ?? []).length === 0 ? <p className="empty">No active Workspace Goals.</p> : <ul className="summary-list">
                {(model.instanceState[entry.name]?.goals ?? []).map((goal) => {
                    const completed = goal.steps.filter((step) => step.status === "completed" || step.status === "skipped").length;
                    return <li data-goal-id={goal.goalId} data-goal-status={goal.status} key={goal.goalId}><strong>{goal.objective}</strong> · {goal.status} · {completed}/{goal.steps.length} steps · {goal.workspace ?? "workspace unavailable"}</li>;
                })}
            </ul>}
            <div className="actions">
                {lifecycleAction === undefined ? null : <button
                    className={lifecycleAction === "Start" ? "primary" : "danger"}
                    disabled={
                        !interactive ||
                        state.operations[`start:${entry.name}`] !== undefined ||
                        state.operations[`stop:${entry.name}`] !== undefined
                    }
                    onClick={() => {
                        if (lifecycleAction === "Start") {
                            void store.start(entry.name);
                            return;
                        }
                        setConfirmation({ action: "Stop", instance: entry.name });
                    }}
                >
                    {lifecycleAction === "Start" && state.operations[`start:${entry.name}`] !== undefined
                        ? "Starting…"
                        : lifecycleAction}
                </button>}
            </div>
            <h4>Recent logs</h4>
            <pre>{(model.instanceState[entry.name]?.logs ?? [])
                .map((log) => `${log.at} ${log.message}`)
                .join("\n") || "No recent logs."}</pre>
        </article>}
        {confirmation === undefined ? null : <ConfirmationDialog
            actionLabel={confirmation.action}
            busy={operation !== undefined && state.operations[operation] !== undefined}
            description={`${confirmation.action} ${confirmation.instance}?`}
            disabled={!interactive}
            onCancel={() => setConfirmation(undefined)}
            onConfirm={() => {
                const request = store.stop(confirmation.instance);
                void request.finally(() => setConfirmation(undefined));
            }}
        />}
    </section>;
}

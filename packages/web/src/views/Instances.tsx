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
    const [selected, setSelected] = useState<string>();
    const [confirmation, setConfirmation] = useState<{
        action: "Start" | "Stop";
        instance: string;
    }>();
    const entry = state.instances.find(({ name }) => name === selected);
    const selectedWorker = state.overview?.instances.find(
        ({ name }) => name === entry?.name,
    )?.worker;
    const operation = confirmation === undefined
        ? undefined
        : `${confirmation.action.toLowerCase()}:${confirmation.instance}`;
    const interactive = state.connection === "online" && !disabled;

    return <section>
        <h2>Instances</h2>
        {state.instances.length === 0
            ? <p className="empty">No instances are available.</p>
            : <div className="instances">
                {state.instances.map((item) => <button
                    className="instance card"
                    key={item.name}
                    onClick={() => {
                        setSelected(item.name);
                        void store.refreshInstance(item.name);
                    }}
                >
                    <strong>{item.name}</strong>
                    <span>{item.snapshot.status} · {item.snapshot.connectionState}</span>
                    <WorkerSummary worker={state.overview?.instances.find(
                        ({ name }) => name === item.name,
                    )?.worker} />
                </button>)}
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
            <WorkerDiagnostics worker={selectedWorker} />
            <div className="actions">
                <button
                    className={entry.snapshot.status === "stopped" ? "primary" : "danger"}
                    disabled={
                        !interactive ||
                        state.operations[`start:${entry.name}`] !== undefined ||
                        state.operations[`stop:${entry.name}`] !== undefined
                    }
                    onClick={() => setConfirmation({
                        action: entry.snapshot.status === "stopped" ? "Start" : "Stop",
                        instance: entry.name,
                    })}
                >
                    {entry.snapshot.status === "stopped" ? "Start" : "Stop"}
                </button>
            </div>
            <h4>Recent logs</h4>
            <pre>{(state.logs[entry.name] ?? [])
                .map((log) => `${log.at} ${log.message}`)
                .join("\n") || "No recent logs."}</pre>
        </article>}
        {confirmation === undefined ? null : <ConfirmationDialog
            actionLabel={confirmation.action}
            busy={operation !== undefined && state.operations[operation] !== undefined}
            description={`${confirmation.action} ${confirmation.instance}?`}
            onCancel={() => setConfirmation(undefined)}
            onConfirm={() => {
                const request = confirmation.action === "Start"
                    ? store.start(confirmation.instance)
                    : store.stop(confirmation.instance);
                void request.finally(() => setConfirmation(undefined));
            }}
        />}
    </section>;
}

import { useEffect, useMemo, useState } from "react";
import type {
    ConfigDraft,
    ConfigInstancePatch,
    JsonValue,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../../state/Model.js";
import type { WebStore } from "../../state/Store.js";

const restartPaths = [
    "provider",
    "ssh",
    "container",
    "dockerBinary",
    "podmanBinary",
    "logs",
    "tools",
] as const;

export function Config({
    disabled,
    state,
    store,
}: {
    disabled: boolean;
    state: WebState;
    store: WebStore;
}) {
    const instances = useMemo(
        () => configInstances(state),
        [state.readModel.configView],
    );
    const [selected, setSelected] = useState<string>();
    const selectedName =
        selected !== undefined &&
        instances.some((entry) => entry.name === selected)
            ? selected
            : instances[0]?.name;
    const baseline = useMemo(
        () =>
            editableInstance(
                instances.find((entry) => entry.name === selectedName),
            ),
        [instances, selectedName],
    );
    const baselineText = useMemo(() => stringify(baseline), [baseline]);
    const [draftText, setDraftText] = useState(baselineText);
    const [feedback, setFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();

    useEffect(() => {
        setDraftText(baselineText);
        setFeedback(undefined);
    }, [baselineText, selectedName]);

    const parsed = useMemo(() => parseInstance(draftText), [draftText]);
    const dirty = draftText !== baselineText;
    const restartRequired =
        parsed.value !== undefined && baseline !== undefined
            ? requiresRestart(baseline, parsed.value)
            : false;
    const snapshot =
        selectedName === undefined
            ? undefined
            : state.readModel.instanceState[selectedName]?.snapshot;
    const running =
        snapshot?.daemonState === "running" || snapshot?.ready === true;
    const selfManaged = snapshot?.reverse?.managementMode === "selfManaged";
    const operationPending = state.operations["config:update"] !== undefined;
    const interactive =
        state.connection === "online" && !disabled && !operationPending;

    async function validate(): Promise<boolean> {
        if (selectedName === undefined || parsed.value === undefined) {
            setFeedback({
                kind: "error",
                text: parsed.error ?? "Select an instance first.",
            });
            return false;
        }
        const draft = fullValidationDraft(
            state.readModel.configView,
            selectedName,
            parsed.value,
        );
        const succeeded = await store.validateConfig(draft);
        setFeedback(
            succeeded
                ? { kind: "success", text: "Configuration is valid." }
                : {
                      kind: "error",
                      text:
                          store.state.error ??
                          "Configuration validation failed.",
                  },
        );
        return succeeded;
    }

    async function save(restart: boolean): Promise<void> {
        if (selectedName === undefined || parsed.value === undefined) return;
        if (!(await validate())) return;
        if (restart && selfManaged) {
            setFeedback({
                kind: "error",
                text: `Instance ${selectedName} is self-managed; restart it on the remote machine.`,
            });
            return;
        }
        if (!restart && restartRequired && running) {
            setFeedback({
                kind: "error",
                text: "These changes require a worker restart. Use Save & Restart or stop the instance first.",
            });
            return;
        }
        let stopped = false;
        if (restart && running) {
            if (!(await store.stop(selectedName))) {
                setFeedback({
                    kind: "error",
                    text:
                        store.state.error ?? `Could not stop ${selectedName}.`,
                });
                return;
            }
            stopped = true;
        }
        const succeeded = await store.updateInstanceConfig(
            selectedName,
            instancePatch(parsed.value),
        );
        if (!succeeded) {
            if (stopped) await store.start(selectedName);
            setFeedback({
                kind: "error",
                text: store.state.error ?? "Configuration could not be saved.",
            });
            return;
        }
        if (stopped) {
            if (!(await store.start(selectedName))) {
                setFeedback({
                    kind: "error",
                    text:
                        store.state.error ??
                        "Saved, but the worker could not be restarted.",
                });
                return;
            }
        }
        const current = editableInstance(
            configInstances(store.state).find(
                (entry) => entry.name === selectedName,
            ),
        );
        setDraftText(stringify(current ?? parsed.value));
        setFeedback({
            kind: "success",
            text: stopped
                ? "Configuration saved and worker restarted."
                : "Configuration saved.",
        });
    }

    if (instances.length === 0) {
        return (
            <section>
                <h2>Config</h2>
                <p className="empty">No instance configuration is available.</p>
            </section>
        );
    }

    return (
        <section className="config-page">
            <div className="page-heading-actions">
                <div>
                    <h2>Config</h2>
                    <p className="hint">
                        Edit the selected instance using the same persisted
                        configuration model as the TUI.
                    </p>
                </div>
                <label className="compact-field">
                    <span>Instance</span>
                    <select
                        onChange={(event) => setSelected(event.target.value)}
                        value={selectedName}
                    >
                        {instances.map((entry) => (
                            <option key={entry.name} value={entry.name}>
                                {entry.name}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            <article className="detail config-editor-panel">
                <div className="config-editor-summary">
                    <strong>{selectedName}</strong>
                    <span>{dirty ? "Unsaved changes" : "Saved"}</span>
                    <span>
                        Apply:{" "}
                        {restartRequired
                            ? selfManaged
                                ? "remote restart"
                                : "restart"
                            : "hot"}
                    </span>
                    <span>Worker: {running ? "running" : "stopped"}</span>
                </div>
                <label className="form-field wide">
                    <span>Instance configuration JSON</span>
                    <textarea
                        aria-label="Instance configuration JSON"
                        disabled={!interactive}
                        onChange={(event) => {
                            setDraftText(event.target.value);
                            setFeedback(undefined);
                        }}
                        rows={24}
                        spellCheck={false}
                        value={draftText}
                    />
                </label>
                {parsed.error === undefined ? null : (
                    <p className="error" role="alert">
                        {parsed.error}
                    </p>
                )}
                {feedback === undefined ? null : (
                    <p
                        className={
                            feedback.kind === "error" ? "error" : "notice"
                        }
                        role={feedback.kind === "error" ? "alert" : "status"}
                    >
                        {feedback.text}
                    </p>
                )}
                <div className="actions">
                    <button
                        disabled={!interactive}
                        onClick={() => {
                            setDraftText(baselineText);
                            setFeedback(undefined);
                        }}
                        type="button"
                    >
                        Cancel
                    </button>
                    <button
                        disabled={!interactive}
                        onClick={() =>
                            void store.refreshConfig().then(
                                () => {
                                    const next = editableInstance(
                                        configInstances(store.state).find(
                                            (entry) =>
                                                entry.name === selectedName,
                                        ),
                                    );
                                    setDraftText(stringify(next));
                                    setFeedback({
                                        kind: "success",
                                        text: "Reloaded from Control.",
                                    });
                                },
                                (error: unknown) =>
                                    setFeedback({
                                        kind: "error",
                                        text: readError(error),
                                    }),
                            )
                        }
                        type="button"
                    >
                        Reload
                    </button>
                    <button
                        disabled={!interactive || parsed.value === undefined}
                        onClick={() => void validate()}
                        type="button"
                    >
                        Validate
                    </button>
                    <button
                        disabled={
                            !interactive ||
                            !dirty ||
                            parsed.value === undefined ||
                            (restartRequired && running)
                        }
                        onClick={() => void save(false)}
                        type="button"
                    >
                        Save Only
                    </button>
                    <button
                        className="primary"
                        disabled={
                            !interactive ||
                            !dirty ||
                            parsed.value === undefined ||
                            !restartRequired ||
                            !running ||
                            selfManaged === true
                        }
                        onClick={() => void save(true)}
                        type="button"
                    >
                        Save & Restart
                    </button>
                </div>
            </article>
        </section>
    );
}

function configInstances(
    state: WebState,
): Array<Record<string, JsonValue> & { name: string }>;
function configInstances(
    state: Pick<WebState, "readModel">,
): Array<Record<string, JsonValue> & { name: string }>;
function configInstances(
    state: Pick<WebState, "readModel">,
): Array<Record<string, JsonValue> & { name: string }> {
    const values = state.readModel.configView?.instances;
    if (!Array.isArray(values)) return [];
    return values.flatMap((value) => {
        const record = asRecord(value);
        return record !== undefined && typeof record.name === "string"
            ? [{ ...record, name: record.name }]
            : [];
    });
}

function editableInstance(
    value: (Record<string, JsonValue> & { name: string }) | undefined,
): Record<string, JsonValue> | undefined {
    if (value === undefined) return undefined;
    const clone = structuredClone(value) as Record<string, JsonValue>;
    const security = asRecord(clone.security);
    if (security !== undefined) {
        delete security.effectiveMode;
        clone.security = security;
    }
    return clone;
}

function parseInstance(raw: string): {
    error?: string;
    value?: Record<string, JsonValue>;
} {
    try {
        const value: unknown = JSON.parse(raw);
        if (typeof value !== "object" || value === null || Array.isArray(value))
            return { error: "Instance configuration must be a JSON object." };
        const record = value as Record<string, JsonValue>;
        if (typeof record.name !== "string" || record.name.length === 0)
            return { error: "Instance configuration requires name." };
        if (typeof record.provider !== "string")
            return { error: "Instance configuration requires provider." };
        return { value: record };
    } catch (error) {
        return { error: `Invalid JSON: ${readError(error)}` };
    }
}

function fullValidationDraft(
    configView: Record<string, JsonValue> | undefined,
    selected: string,
    next: Record<string, JsonValue>,
): ConfigDraft {
    const instances = Array.isArray(configView?.instances)
        ? configView.instances.flatMap((entry) => {
              const record = asRecord(entry);
              if (record === undefined || typeof record.name !== "string")
                  return [];
              return [
                  (record.name === selected
                      ? next
                      : editableInstance({
                            ...record,
                            name: record.name,
                        })!) as never,
              ];
          })
        : [next as never];
    return {
        control: asRecord(configView?.control) as ConfigDraft["control"],
        instances,
        mcp: asRecord(configView?.mcp) as ConfigDraft["mcp"],
        web: asRecord(configView?.web) as ConfigDraft["web"],
    };
}

function instancePatch(value: Record<string, JsonValue>): ConfigInstancePatch {
    const clone = structuredClone(value) as Record<string, JsonValue>;
    delete clone.name;
    const security = asRecord(clone.security);
    if (security !== undefined) {
        delete security.effectiveMode;
        clone.security = security;
    }
    return clone as ConfigInstancePatch;
}

function requiresRestart(
    previous: Record<string, JsonValue>,
    next: Record<string, JsonValue>,
): boolean {
    return restartPaths.some(
        (path) => JSON.stringify(previous[path]) !== JSON.stringify(next[path]),
    );
}

function asRecord(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function stringify(value: Record<string, JsonValue> | undefined): string {
    return JSON.stringify(value ?? {}, null, 2);
}

function readError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

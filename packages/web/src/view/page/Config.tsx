import { useEffect, useMemo, useState } from "react";
import {
    configInstanceChangedPaths,
    configInstanceRequiresRestart,
} from "@portable-devshell/shared/browser";
import type {
    ConfigDraft,
    ConfigInstancePatch,
    JsonValue,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../../state/Model.js";
import type { WebStore } from "../../state/Store.js";
import type { WebRoute } from "../../app/Route.js";

export function Config({
    disabled,
    navigate,
    route,
    state,
    store,
}: {
    disabled: boolean;
    navigate(route: WebRoute): void;
    route: Extract<WebRoute, { page: "config" }>;
    state: WebState;
    store: WebStore;
}) {
    const instances = useMemo(
        () => configInstances(state),
        [state.readModel.configView],
    );
    const selectedName =
        route.instance !== undefined &&
        instances.some((entry) => entry.name === route.instance)
            ? route.instance
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
    const changedPaths =
        parsed.value !== undefined && baseline !== undefined
            ? configInstanceChangedPaths(baseline, parsed.value)
            : [];
    const dirty =
        parsed.value === undefined || baseline === undefined
            ? draftText !== baselineText
            : changedPaths.length > 0;
    const restartRequired =
        parsed.value !== undefined && baseline !== undefined
            ? configInstanceRequiresRestart(baseline, parsed.value)
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

    function updateDraft(path: string, value: JsonValue | undefined): void {
        if (parsed.value === undefined) return;
        setDraftText(stringify(setPath(parsed.value, path, value)));
        setFeedback(undefined);
    }

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
                        onChange={(event) =>
                            navigate({
                                page: "config",
                                instance: event.target.value,
                            })
                        }
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
                <div className="control-grid config-structured-grid">
                    <article className="card">
                        <h3>General</h3>
                        <div className="form-grid">
                            <Check
                                checked={booleanValue(
                                    parsed.value,
                                    "enabled",
                                    true,
                                )}
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Instance enabled"
                                onChange={(value) =>
                                    updateDraft("enabled", value)
                                }
                            />
                            <Field label="Provider">
                                <select
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(event) =>
                                        updateDraft(
                                            "provider",
                                            event.target.value,
                                        )
                                    }
                                    value={stringValue(
                                        parsed.value,
                                        "provider",
                                        "local",
                                    )}
                                >
                                    {[
                                        "local",
                                        "ssh",
                                        "docker",
                                        "podman",
                                        "reverse",
                                    ].map((provider) => (
                                        <option key={provider} value={provider}>
                                            {provider}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            {stringValue(parsed.value, "provider", "local") ===
                            "ssh" ? (
                                <Field label="SSH command" wide>
                                    <input
                                        disabled={
                                            !interactive ||
                                            parsed.value === undefined
                                        }
                                        onChange={(event) =>
                                            updateDraft(
                                                "ssh.command",
                                                event.target.value,
                                            )
                                        }
                                        value={stringValue(
                                            parsed.value,
                                            "ssh.command",
                                            "",
                                        )}
                                    />
                                </Field>
                            ) : null}
                            {stringValue(parsed.value, "provider", "local") ===
                            "docker" ? (
                                <Field label="Docker binary">
                                    <input
                                        disabled={
                                            !interactive ||
                                            parsed.value === undefined
                                        }
                                        onChange={(event) =>
                                            updateDraft(
                                                "dockerBinary",
                                                optionalText(
                                                    event.target.value,
                                                ),
                                            )
                                        }
                                        value={stringValue(
                                            parsed.value,
                                            "dockerBinary",
                                            "",
                                        )}
                                    />
                                </Field>
                            ) : null}
                            {stringValue(parsed.value, "provider", "local") ===
                            "podman" ? (
                                <Field label="Podman binary">
                                    <input
                                        disabled={
                                            !interactive ||
                                            parsed.value === undefined
                                        }
                                        onChange={(event) =>
                                            updateDraft(
                                                "podmanBinary",
                                                optionalText(
                                                    event.target.value,
                                                ),
                                            )
                                        }
                                        value={stringValue(
                                            parsed.value,
                                            "podmanBinary",
                                            "",
                                        )}
                                    />
                                </Field>
                            ) : null}
                        </div>
                    </article>

                    <article className="card">
                        <h3>MCP & Workspace</h3>
                        <div className="form-grid">
                            <Check
                                checked={booleanValue(
                                    parsed.value,
                                    "mcp.enabled",
                                    true,
                                )}
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="MCP enabled"
                                onChange={(value) =>
                                    updateDraft("mcp.enabled", value)
                                }
                            />
                            <Field label="Context mode">
                                <select
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(event) =>
                                        updateDraft(
                                            "mcp.contextMode",
                                            event.target.value,
                                        )
                                    }
                                    value={stringValue(
                                        parsed.value,
                                        "mcp.contextMode",
                                        "explicit",
                                    )}
                                >
                                    <option value="explicit">explicit</option>
                                    <option value="openai-session">
                                        openai-session
                                    </option>
                                </select>
                            </Field>
                            <Field label="MCP path">
                                <input
                                    disabled
                                    value={stringValue(
                                        parsed.value,
                                        "mcp.path",
                                        `/${selectedName}/mcp`,
                                    )}
                                />
                            </Field>
                            <Check
                                checked={booleanValue(
                                    parsed.value,
                                    "workspace.enabled",
                                    true,
                                )}
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Workspace enabled"
                                onChange={(value) =>
                                    updateDraft("workspace.enabled", value)
                                }
                            />
                        </div>
                    </article>

                    <article className="card">
                        <h3>Model & Security</h3>
                        <div className="form-grid">
                            <Field label="Model extensions" wide>
                                <input
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(event) =>
                                        updateDraft(
                                            "extensions.model",
                                            splitList(event.target.value),
                                        )
                                    }
                                    value={stringListValue(
                                        parsed.value,
                                        "extensions.model",
                                    )}
                                />
                            </Field>
                            <Field label="Security mode">
                                <select
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(event) =>
                                        updateDraft(
                                            "security.mode",
                                            event.target.value,
                                        )
                                    }
                                    value={stringValue(
                                        parsed.value,
                                        "security.mode",
                                        "disabled",
                                    )}
                                >
                                    <option value="disabled">disabled</option>
                                    <option value="workspace">workspace</option>
                                </select>
                            </Field>
                            <Field label="Approval mode">
                                <select
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(event) =>
                                        updateDraft(
                                            "approvalPolicy.mode",
                                            event.target.value,
                                        )
                                    }
                                    value={stringValue(
                                        parsed.value,
                                        "approvalPolicy.mode",
                                        "disabled",
                                    )}
                                >
                                    <option value="disabled">disabled</option>
                                    <option value="allow">allow</option>
                                    <option value="ask">ask</option>
                                    <option value="deny">deny</option>
                                </select>
                            </Field>
                        </div>
                    </article>

                    <article className="card">
                        <h3>Runtime</h3>
                        <div className="form-grid">
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Log retention days"
                                onChange={(value) =>
                                    updateDraft("logs.retentionDays", value)
                                }
                                value={numberValue(
                                    parsed.value,
                                    "logs.retentionDays",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Log max bytes"
                                onChange={(value) =>
                                    updateDraft("logs.maxBytes", value)
                                }
                                value={numberValue(
                                    parsed.value,
                                    "logs.maxBytes",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Log event buffer size"
                                onChange={(value) =>
                                    updateDraft("logs.eventBufferSize", value)
                                }
                                value={numberValue(
                                    parsed.value,
                                    "logs.eventBufferSize",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Max running tools"
                                onChange={(value) =>
                                    updateDraft(
                                        "tools.scheduler.maxRunning",
                                        value,
                                    )
                                }
                                value={numberValue(
                                    parsed.value,
                                    "tools.scheduler.maxRunning",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Max running per session"
                                onChange={(value) =>
                                    updateDraft(
                                        "tools.scheduler.maxRunningPerSession",
                                        value,
                                    )
                                }
                                value={numberValue(
                                    parsed.value,
                                    "tools.scheduler.maxRunningPerSession",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Queue depth"
                                onChange={(value) =>
                                    updateDraft(
                                        "tools.scheduler.queueDepth",
                                        value,
                                    )
                                }
                                value={numberValue(
                                    parsed.value,
                                    "tools.scheduler.queueDepth",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Queue depth per session"
                                onChange={(value) =>
                                    updateDraft(
                                        "tools.scheduler.queueDepthPerSession",
                                        value,
                                    )
                                }
                                value={numberValue(
                                    parsed.value,
                                    "tools.scheduler.queueDepthPerSession",
                                )}
                            />
                            <NumberField
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Queue timeout ms"
                                onChange={(value) =>
                                    updateDraft(
                                        "tools.scheduler.queueTimeoutMs",
                                        value,
                                    )
                                }
                                value={numberValue(
                                    parsed.value,
                                    "tools.scheduler.queueTimeoutMs",
                                )}
                            />
                        </div>
                    </article>
                </div>
                <details className="config-advanced-editor">
                    <summary>Advanced instance JSON</summary>
                    <label className="form-field wide">
                        <span className="sr-only">Advanced instance JSON</span>
                        <textarea
                            aria-label="Advanced instance JSON"
                            disabled={!interactive}
                            onChange={(event) => {
                                setDraftText(event.target.value);
                                setFeedback(undefined);
                            }}
                            rows={18}
                            spellCheck={false}
                            value={draftText}
                        />
                    </label>
                </details>
                {changedPaths.length === 0 ||
                parsed.value === undefined ? null : (
                    <details className="config-change-summary">
                        <summary>
                            {changedPaths.length} pending change
                            {changedPaths.length === 1 ? "" : "s"}
                        </summary>
                        <ul>
                            {changedPaths.map((path) => (
                                <li key={path}>{path}</li>
                            ))}
                        </ul>
                    </details>
                )}
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

function readPath(
    value: Record<string, JsonValue> | undefined,
    path: string,
): JsonValue | undefined {
    let current: JsonValue | undefined = value;
    for (const segment of path.split(".")) {
        const record = asRecord(current);
        if (record === undefined) return undefined;
        current = record[segment];
    }
    return current;
}

function setPath(
    value: Record<string, JsonValue>,
    path: string,
    next: JsonValue | undefined,
): Record<string, JsonValue> {
    const root = structuredClone(value) as Record<string, JsonValue>;
    const segments = path.split(".");
    let current = root;
    for (const segment of segments.slice(0, -1)) {
        const existing = asRecord(current[segment]);
        const child = existing === undefined ? {} : { ...existing };
        current[segment] = child;
        current = child;
    }
    const leaf = segments.at(-1)!;
    if (next === undefined) delete current[leaf];
    else current[leaf] = next;
    return root;
}

function booleanValue(
    value: Record<string, JsonValue> | undefined,
    path: string,
    fallback: boolean,
): boolean {
    const current = readPath(value, path);
    return typeof current === "boolean" ? current : fallback;
}

function stringValue(
    value: Record<string, JsonValue> | undefined,
    path: string,
    fallback: string,
): string {
    const current = readPath(value, path);
    return typeof current === "string" ? current : fallback;
}

function stringListValue(
    value: Record<string, JsonValue> | undefined,
    path: string,
): string {
    const current = readPath(value, path);
    return Array.isArray(current)
        ? current
              .filter((item): item is string => typeof item === "string")
              .join(", ")
        : "";
}

function splitList(value: string): string[] {
    return value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean);
}

function numberValue(
    value: Record<string, JsonValue> | undefined,
    path: string,
): number | undefined {
    const current = readPath(value, path);
    return typeof current === "number" ? current : undefined;
}

function optionalText(value: string): string | undefined {
    return value.trim().length === 0 ? undefined : value;
}

function Field({
    children,
    label,
    wide = false,
}: {
    children: React.ReactNode;
    label: string;
    wide?: boolean;
}) {
    return (
        <label className={wide ? "form-field wide" : "form-field"}>
            <span>{label}</span>
            {children}
        </label>
    );
}

function Check({
    checked,
    disabled,
    label,
    onChange,
}: {
    checked: boolean;
    disabled: boolean;
    label: string;
    onChange(value: boolean): void;
}) {
    return (
        <label className="check-field">
            <input
                checked={checked}
                disabled={disabled}
                onChange={(event) => onChange(event.target.checked)}
                type="checkbox"
            />
            <span>{label}</span>
        </label>
    );
}

function NumberField({
    disabled,
    label,
    onChange,
    value,
}: {
    disabled: boolean;
    label: string;
    onChange(value: number | undefined): void;
    value: number | undefined;
}) {
    return (
        <Field label={label}>
            <input
                disabled={disabled}
                min={0}
                onChange={(event) => {
                    const raw = event.target.value;
                    onChange(raw.length === 0 ? undefined : Number(raw));
                }}
                type="number"
                value={value ?? ""}
            />
        </Field>
    );
}

function readError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

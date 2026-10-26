import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
    configInstanceChangedPaths,
    configInstanceRequiresRestart,
} from "@portable-devshell/shared";
import type {
    ConfigDraft,
    ConfigInstancePatch,
    ConfigView,
    JsonValue,
} from "@portable-devshell/shared";

import { ListInput } from "../component/ListInput.js";
import { useDomainSnapshot, useWebDomains } from "../../app/domain/Context.js";
import type { WebStore } from "../../state/Store.js";

export function Config({
    disabled,
    instance,
    store,
}: {
    disabled: boolean;
    instance?: string;
    store: WebStore;
}) {
    const domains = useWebDomains();
    const config = useDomainSnapshot(domains.config);
    const instancesState = useDomainSnapshot(domains.instances);
    const server = useDomainSnapshot(domains.server);
    const configView = config.view;
    const instances = useMemo(
        () => configInstances(configView),
        [configView],
    );
    const selectedName =
        instance === undefined
            ? instances[0]?.name
            : instances.some((entry) => entry.name === instance)
              ? instance
              : undefined;
    const serverBaseline = useMemo(
        () =>
            editableInstance(
                instances.find((entry) => entry.name === selectedName),
            ),
        [instances, selectedName],
    );
    const baselineText = useMemo(() => stringify(serverBaseline), [serverBaseline]);
    const [editor, setEditor] = useState({ baselineText, text: baselineText });
    const draftText = editor.text;
    const baseline = useMemo(() => parseInstance(editor.baselineText).value, [editor.baselineText]);
    function setDraftText(text: string): void {
        setEditor((previous) => ({ ...previous, text }));
    }
    const [busy, setBusy] = useState(false);
    const [restartRecovery, setRestartRecovery] = useState(false);
    const epoch = useRef(0);
    const working = useRef(false);
    const storeState = useSyncExternalStore(store.subscribe, () => store.state, () => store.state);
    const [feedback, setFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();

    useEffect(() => {
        epoch.current += 1;
        working.current = false;
        setBusy(false);
        setRestartRecovery(false);
        setEditor({ baselineText, text: baselineText });
        setFeedback(undefined);
        return () => { epoch.current += 1; };
    }, [selectedName]);
    useEffect(() => {
        setEditor((previous) => previous.text === previous.baselineText
            ? { baselineText, text: baselineText }
            : previous);
    }, [baselineText]);

    const parsed = useMemo(() => parseInstance(draftText), [draftText]);
    const changedPaths =
        parsed.value !== undefined && baseline !== undefined
            ? configInstanceChangedPaths(baseline, parsed.value)
            : [];
    const dirty =
        parsed.value === undefined || baseline === undefined
            ? draftText !== editor.baselineText
            : changedPaths.length > 0;
    const restartRequired =
        parsed.value !== undefined && baseline !== undefined
            ? configInstanceRequiresRestart(baseline, parsed.value)
            : false;
    const snapshot =
        selectedName === undefined
            ? undefined
            : instancesState.instances.find(
                  (entry) => entry.name === selectedName,
              )?.snapshot;
    const running =
        snapshot?.daemonState === "running" || snapshot?.ready === true;
    const selfManaged = snapshot?.reverse?.managementMode === "selfManaged";
    const operationPending =
        busy || storeState.operations["config:update"] !== undefined ||
        storeState.operations["config:validate"] !== undefined;
    const interactive =
        server.status === "online" && !disabled && !operationPending;

    function updateDraft(path: string, value: JsonValue | undefined): void {
        if (parsed.value === undefined) return;
        setDraftText(stringify(setPath(parsed.value, path, value)));
        setFeedback(undefined);
    }

    async function validate(requestEpoch: number): Promise<boolean> {
        if (selectedName === undefined || parsed.value === undefined) {
            setFeedback({
                kind: "error",
                text: parsed.error ?? "Select an instance first.",
            });
            return false;
        }
        const draft = fullValidationDraft(
            configView,
            selectedName,
            parsed.value,
        );
        const succeeded = await store.validateConfig(draft);
        if (requestEpoch !== epoch.current) return false;
        setFeedback(
            succeeded
                ? { kind: "success", text: "Configuration is valid." }
                : {
                      kind: "error",
                      text:
                          store.operationFailure("config:validate") ??
                          "Configuration validation failed.",
                  },
        );
        return succeeded;
    }

    async function save(restart: boolean): Promise<void> {
        if (!interactive || working.current || selectedName === undefined || parsed.value === undefined) return;
        working.current = true;
        setBusy(true);
        const requestEpoch = epoch.current;
        const current = () => requestEpoch === epoch.current;
        try {
            if (!(await validate(requestEpoch))) return;
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
                    if (!current()) return;
                    setFeedback({
                        kind: "error",
                        text:
                            store.operationFailure(`stop:${selectedName}`) ?? `Could not stop ${selectedName}.`,
                    });
                    return;
                }
                stopped = true;
            }
            const succeeded = await store.updateConfig({
                instance: {
                    instanceName: selectedName,
                    patch: instancePatch(parsed.value),
                },
            });
            if (!succeeded) {
                const failure = store.operationFailure("config:update") ?? "Configuration could not be saved.";
                const restored = !stopped || await store.start(selectedName);
                if (!current()) return;
                setRestartRecovery(!restored);
                setFeedback({
                    kind: "error",
                    text: restored ? failure : `${failure} Recovery start failed: ${store.operationFailure(`start:${selectedName}`)}`,
                });
                return;
            }
            if (current()) setEditor({ baselineText: draftText, text: draftText });
            if (stopped) {
                if (!(await store.start(selectedName))) {
                    if (!current()) return;
                    setRestartRecovery(true);
                    setFeedback({
                        kind: "error",
                        text:
                            `Configuration saved, but the worker could not be restarted: ${store.operationFailure(`start:${selectedName}`)}`,
                    });
                    return;
                }
            }
            if (!current()) return;
            if (stopped) setRestartRecovery(false);
            setFeedback({
                kind: "success",
                text: stopped
                    ? "Configuration saved and worker restarted."
                    : "Configuration saved.",
            });
        } finally {
            if (current()) {
                working.current = false;
                setBusy(false);
            }
        }
    }

    async function runValidation(): Promise<void> {
        if (!interactive || working.current) return;
        working.current = true;
        setBusy(true);
        const requestEpoch = epoch.current;
        try { await validate(requestEpoch); }
        finally {
            if (requestEpoch === epoch.current) { working.current = false; setBusy(false); }
        }
    }

    async function reload(): Promise<void> {
        if (!interactive || working.current) return;
        working.current = true;
        setBusy(true);
        const requestEpoch = epoch.current;
        try {
            await domains.config.refresh();
            if (requestEpoch !== epoch.current) return;
            const failure = domains.config.state.failure;
            if (failure !== undefined) throw failure;
            const next = editableInstance(configInstances(domains.config.state.view).find((entry) => entry.name === selectedName));
            const text = stringify(next);
            setEditor({ baselineText: text, text });
            setFeedback({ kind: "success", text: "Reloaded from Control." });
        } catch (error) {
            if (requestEpoch === epoch.current) setFeedback({ kind: "error", text: readError(error) });
        } finally {
            if (requestEpoch === epoch.current) { working.current = false; setBusy(false); }
        }
    }

    async function retryStart(): Promise<void> {
        if (!interactive || working.current || selectedName === undefined) return;
        working.current = true;
        setBusy(true);
        const requestEpoch = epoch.current;
        try {
            const succeeded = await store.start(selectedName);
            if (requestEpoch !== epoch.current) return;
            setRestartRecovery(!succeeded);
            setFeedback(succeeded ? { kind: "success", text: "Worker restarted." } : {
                kind: "error", text: store.operationFailure(`start:${selectedName}`) ?? `Could not start ${selectedName}.`,
            });
        } finally {
            if (requestEpoch === epoch.current) { working.current = false; setBusy(false); }
        }
    }

    if (selectedName === undefined) {
        return (
            <section className="config-page instance-subview">
                <h3>Config</h3>
                <p className="empty">
                    {instance === undefined
                        ? "No instance configuration is available."
                        : `No configuration is available for ${instance}.`}
                </p>
            </section>
        );
    }

    return (
        <section className="config-page instance-subview">
            <div className="instance-subview-heading">
                <h3>Config</h3>
                <p className="hint">
                    Persisted configuration for {selectedName}.
                </p>
            </div>

            <article className="config-editor-panel">
                <div className="config-editor-summary">
                    <strong>{selectedName}</strong>
                    <span>{operationPending ? "Working…" : dirty ? "Unsaved changes" : "Saved"}</span>
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
                                        "openai-session",
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
                                    false,
                                )}
                                disabled={
                                    !interactive || parsed.value === undefined
                                }
                                label="Workspace enabled"
                                onChange={(value) =>
                                    updateDraft("workspace.enabled", value)
                                }
                            />
                            <Check
                                checked={booleanValue(
                                    parsed.value,
                                    "workspace.inlineToolCalls",
                                    false,
                                )}
                                disabled={!interactive || parsed.value === undefined}
                                label="Inline ToolCall UI (optional)"
                                onChange={(value) =>
                                    updateDraft("workspace.inlineToolCalls", value)
                                }
                            />
                        </div>
                    </article>

                    <article className="card">
                        <h3>Model & Security</h3>
                        <div className="form-grid">
                            <Field label="Model extensions" wide>
                                <ListInput
                                    disabled={
                                        !interactive ||
                                        parsed.value === undefined
                                    }
                                    onChange={(raw) =>
                                        updateDraft(
                                            "extensions.model",
                                            splitList(raw),
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
                    {restartRecovery ? <button disabled={!interactive} onClick={() => void retryStart()} type="button">Retry Start</button> : null}
                    <button
                        disabled={!interactive}
                        onClick={() => {
                            setEditor({ baselineText, text: baselineText });
                            setFeedback(undefined);
                        }}
                        type="button"
                    >
                        Cancel
                    </button>
                    <button
                        disabled={!interactive}
                        onClick={() => void reload()}
                        type="button"
                    >
                        Reload
                    </button>
                    <button
                        disabled={!interactive || parsed.value === undefined}
                        onClick={() => void runValidation()}
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
    view: ConfigView | undefined,
): Array<Record<string, JsonValue> & { name: string }> {
    const values = view?.instances;
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
    configView: ConfigView | undefined,
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

function asRecord(value: unknown): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, JsonValue>)
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

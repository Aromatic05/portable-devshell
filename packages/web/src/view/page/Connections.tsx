import { useEffect, useMemo, useState } from "react";
import type {
    ConfigDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
    ConfigWebPatch,
    JsonValue,
    OAuthApprovalRequest,
} from "@portable-devshell/shared/browser";

import type { WebState } from "../../state/Model.js";
import type { WebStore } from "../../state/Store.js";
import { ConfirmationDialog } from "../component/Confirm.js";

interface ConnectionDrafts {
    instanceMcp: ConfigInstancePatch["mcp"];
    mcp: ConfigMcpPatch;
    web: ConfigWebPatch;
}

export function Connections({
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
    const base = useMemo(
        () => connectionDrafts(state.readModel.configView, selectedName),
        [state.readModel.configView, selectedName],
    );
    const [drafts, setDrafts] = useState<ConnectionDrafts>(base);
    const [feedback, setFeedback] = useState<{
        kind: "error" | "success";
        text: string;
    }>();
    const [enrollment, setEnrollment] = useState<string>();
    const [confirm, setConfirm] = useState<"revoke" | "rotate">();
    const [restartingControl, setRestartingControl] = useState(false);

    useEffect(() => {
        setDrafts(base);
        setFeedback(undefined);
        setEnrollment(undefined);
    }, [base]);

    const selectedEntry = instances.find(
        (entry) => entry.name === selectedName,
    );
    const snapshot =
        selectedName === undefined
            ? undefined
            : state.readModel.instanceState[selectedName]?.snapshot;
    const dirty = JSON.stringify(drafts) !== JSON.stringify(base);
    const pending = state.operations["config:update"] !== undefined;
    const interactive = state.connection === "online" && !disabled && !pending;
    const mcpStatus = state.readModel.mcpStatus;
    const controlRestartRequired =
        state.readModel.configView?.restartControlRequired === true;

    async function validate(): Promise<boolean> {
        if (selectedName === undefined) return false;
        const draft = fullValidationDraft(
            state.readModel.configView,
            selectedName,
            drafts,
        );
        const succeeded = await store.validateConfig(draft);
        setFeedback(
            succeeded
                ? {
                      kind: "success",
                      text: "Connection configuration is valid.",
                  }
                : {
                      kind: "error",
                      text:
                          store.state.error ?? "Connection validation failed.",
                  },
        );
        return succeeded;
    }

    async function save(): Promise<void> {
        if (selectedName === undefined || !(await validate())) return;
        const succeeded = await store.updateConfig({
            instance: {
                instanceName: selectedName,
                patch: { mcp: drafts.instanceMcp },
            },
            mcp: drafts.mcp,
            web: drafts.web,
        });
        if (!succeeded) {
            setFeedback({
                kind: "error",
                text:
                    store.state.error ??
                    "Connection configuration could not be saved.",
            });
            return;
        }
        setDrafts(
            connectionDrafts(store.state.readModel.configView, selectedName),
        );
        setFeedback({
            kind: "success",
            text:
                store.state.readModel.configView?.restartControlRequired ===
                true
                    ? "Saved. Restart Control to apply endpoint changes."
                    : "Connection configuration saved.",
        });
    }

    if (selectedName === undefined) {
        return (
            <section>
                <h2>Connections</h2>
                <p className="empty">No instances are available.</p>
            </section>
        );
    }

    return (
        <section className="connections-page">
            <div className="page-heading-actions">
                <div>
                    <h2>Connections</h2>
                    <p className="hint">
                        MCP/Web endpoints, authentication, OAuth and reverse
                        enrollment.
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

            <div className="control-grid">
                <article className="card connection-status-card">
                    <h3>Connection endpoints</h3>
                    <dl>
                        <dt>Local MCP</dt>
                        <dd>{localMcpEndpoint(selectedName, drafts)}</dd>
                        <dt>Public MCP</dt>
                        <dd>{publicMcpEndpoint(drafts)}</dd>
                        <dt>Web UI</dt>
                        <dd>{webEndpoint(drafts)}</dd>
                        <dt>MCP runtime</dt>
                        <dd>
                            {mcpStatus?.running === true
                                ? "running"
                                : "stopped"}
                        </dd>
                        <dt>Auth</dt>
                        <dd>{String(drafts.instanceMcp?.auth ?? "none")}</dd>
                    </dl>
                    {controlRestartRequired ? (
                        <p className="notice">
                            Saved endpoint configuration is pending a Control
                            restart.
                        </p>
                    ) : null}
                </article>

                <article className="card">
                    <h3>[Instance] MCP</h3>
                    <div className="form-grid">
                        <Check
                            checked={drafts.instanceMcp?.enabled !== false}
                            label="Enabled"
                            onChange={(enabled) =>
                                setDrafts((current) => ({
                                    ...current,
                                    instanceMcp: {
                                        ...current.instanceMcp,
                                        enabled,
                                    },
                                }))
                            }
                        />
                        <Field label="Path">
                            <input
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        instanceMcp: {
                                            ...current.instanceMcp,
                                            path: event.target.value,
                                        },
                                    }))
                                }
                                value={String(
                                    drafts.instanceMcp?.path ??
                                        `/${selectedName}/mcp`,
                                )}
                            />
                        </Field>
                        <AuthFields
                            auth={drafts.instanceMcp?.auth ?? "none"}
                            oauth2={drafts.instanceMcp?.oauth2}
                            onChange={(patch) =>
                                setDrafts((current) => ({
                                    ...current,
                                    instanceMcp: {
                                        ...current.instanceMcp,
                                        ...patch,
                                    },
                                }))
                            }
                            token={drafts.instanceMcp?.token}
                        />
                    </div>
                </article>

                <article className="card">
                    <h3>[Global] MCP listener</h3>
                    <div className="form-grid">
                        <Check
                            checked={drafts.mcp.enabled !== false}
                            label="Enabled"
                            onChange={(enabled) =>
                                setDrafts((current) => ({
                                    ...current,
                                    mcp: { ...current.mcp, enabled },
                                }))
                            }
                        />
                        <Field label="Listen host">
                            <input
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        mcp: {
                                            ...current.mcp,
                                            listenHost: event.target.value,
                                        },
                                    }))
                                }
                                value={String(
                                    drafts.mcp.listenHost ?? "127.0.0.1",
                                )}
                            />
                        </Field>
                        <Field label="Listen port">
                            <input
                                inputMode="numeric"
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        mcp: {
                                            ...current.mcp,
                                            listenPort: parsePort(
                                                event.target.value,
                                            ),
                                        },
                                    }))
                                }
                                value={String(drafts.mcp.listenPort ?? 0)}
                            />
                        </Field>
                        <Field label="Public base URL">
                            <input
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        mcp: {
                                            ...current.mcp,
                                            publicBaseUrl: event.target.value,
                                        },
                                    }))
                                }
                                value={String(drafts.mcp.publicBaseUrl ?? "")}
                            />
                        </Field>
                    </div>
                </article>

                <article className="card">
                    <h3>[Global] Web UI</h3>
                    <div className="form-grid">
                        <Check
                            checked={drafts.web.enabled !== false}
                            label="Enabled"
                            onChange={(enabled) =>
                                setDrafts((current) => ({
                                    ...current,
                                    web: { ...current.web, enabled },
                                }))
                            }
                        />
                        <AuthFields
                            auth={drafts.web.auth ?? "none"}
                            oauth2={drafts.web.oauth2}
                            onChange={(patch) =>
                                setDrafts((current) => ({
                                    ...current,
                                    web: { ...current.web, ...patch },
                                }))
                            }
                            token={drafts.web.token}
                        />
                        <Field label="Listen host">
                            <input
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        web: {
                                            ...current.web,
                                            listenHost: event.target.value,
                                        },
                                    }))
                                }
                                value={String(
                                    drafts.web.listenHost ?? "127.0.0.1",
                                )}
                            />
                        </Field>
                        <Field label="Listen port">
                            <input
                                inputMode="numeric"
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        web: {
                                            ...current.web,
                                            listenPort: parsePort(
                                                event.target.value,
                                            ),
                                        },
                                    }))
                                }
                                value={String(drafts.web.listenPort ?? 0)}
                            />
                        </Field>
                        <Field label="Public base URL">
                            <input
                                onChange={(event) =>
                                    setDrafts((current) => ({
                                        ...current,
                                        web: {
                                            ...current.web,
                                            publicBaseUrl: event.target.value,
                                        },
                                    }))
                                }
                                value={String(drafts.web.publicBaseUrl ?? "")}
                            />
                        </Field>
                    </div>
                </article>
            </div>

            <article className="detail connection-actions">
                <h3>Configuration actions</h3>
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
                        disabled={!interactive || !dirty}
                        onClick={() => setDrafts(base)}
                        type="button"
                    >
                        Cancel
                    </button>
                    <button
                        disabled={!interactive}
                        onClick={() => void validate()}
                        type="button"
                    >
                        Validate
                    </button>
                    <button
                        className="primary"
                        disabled={!interactive || !dirty}
                        onClick={() => void save()}
                        type="button"
                    >
                        Save
                    </button>
                    <button
                        disabled={
                            !interactive ||
                            !controlRestartRequired ||
                            restartingControl
                        }
                        onClick={() => {
                            setRestartingControl(true);
                            void store.restartControl().then((succeeded) => {
                                setFeedback(
                                    succeeded
                                        ? {
                                              kind: "success",
                                              text: "Control restarted; connection settings are live.",
                                          }
                                        : {
                                              kind: "error",
                                              text:
                                                  store.state.error ??
                                                  "Control restart failed.",
                                          },
                                );
                                setRestartingControl(false);
                            });
                        }}
                        type="button"
                    >
                        {restartingControl ? "Restarting…" : "Restart Control"}
                    </button>
                </div>
            </article>

            <OAuthSection
                approvals={state.readModel.oauthApprovals}
                status={mcpStatus}
            />

            {selectedEntry?.provider === "reverse" ? (
                <article className="detail reverse-connection-panel">
                    <h3>Reverse connection · {selectedName}</h3>
                    <dl>
                        <dt>Connection</dt>
                        <dd>{snapshot?.connectionState ?? "unknown"}</dd>
                        <dt>Daemon</dt>
                        <dd>{snapshot?.daemonState ?? "unknown"}</dd>
                        <dt>Status</dt>
                        <dd>{snapshot?.status ?? "unknown"}</dd>
                    </dl>
                    {enrollment === undefined ? null : <pre>{enrollment}</pre>}
                    <div className="actions">
                        <button
                            disabled={!interactive}
                            onClick={() =>
                                void store
                                    .createReverseCode(selectedName)
                                    .then((value) => {
                                        if (value !== undefined)
                                            setEnrollment(value);
                                    })
                            }
                            type="button"
                        >
                            Create enrollment code
                        </button>
                        <button
                            disabled={!interactive}
                            onClick={() => setConfirm("rotate")}
                            type="button"
                        >
                            Rotate device token
                        </button>
                        <button
                            className="danger"
                            disabled={!interactive}
                            onClick={() => setConfirm("revoke")}
                            type="button"
                        >
                            Revoke device token
                        </button>
                    </div>
                </article>
            ) : null}

            {confirm === undefined ? null : (
                <ConfirmationDialog
                    actionLabel={confirm === "rotate" ? "Rotate" : "Revoke"}
                    busy={
                        state.operations[
                            confirm === "rotate"
                                ? `reverse:rotate:${selectedName}`
                                : `reverse:revoke:${selectedName}`
                        ] !== undefined
                    }
                    description={
                        confirm === "rotate"
                            ? `Rotate the device token for ${selectedName}? Existing credentials will stop working.`
                            : `Revoke the device token for ${selectedName}? The remote worker must enroll again.`
                    }
                    variant="destructive"
                    onCancel={() => setConfirm(undefined)}
                    onConfirm={() => {
                        const request =
                            confirm === "rotate"
                                ? store.rotateReverseToken(selectedName)
                                : store.revokeReverseToken(selectedName);
                        void request.then((succeeded) => {
                            if (succeeded) setConfirm(undefined);
                        });
                    }}
                />
            )}
        </section>
    );
}

function OAuthSection({
    approvals,
    status,
}: {
    approvals: OAuthApprovalRequest[];
    status: WebState["readModel"]["mcpStatus"];
}) {
    const pending = approvals.filter(
        (approval) => approval.status === "pending",
    );
    return (
        <article className="detail oauth-panel">
            <h3>OAuth runtime</h3>
            <p className="hint">
                provider={status?.authMode ?? "none"} · runtime=
                {status?.running === true ? "running" : "stopped"} · pending=
                {pending.length}
            </p>
            {pending.length === 0 ? (
                <p className="empty">
                    No OAuth requests are waiting for review.
                </p>
            ) : (
                <div>
                    <p className="hint">
                        Review OAuth requests in the unified approval queue.
                    </p>
                    <a href="#/approvals">Review pending approvals</a>
                </div>
            )}
        </article>
    );
}

function AuthFields({
    auth,
    oauth2,
    onChange,
    token,
}: {
    auth: "none" | "oauth2" | "token";
    oauth2?: {
        documentationUrl?: string;
        requiredScopes?: string[];
        resourceName: string;
    };
    onChange(patch: {
        auth?: "none" | "oauth2" | "token";
        oauth2?: {
            documentationUrl?: string;
            requiredScopes?: string[];
            resourceName: string;
        };
        token?: string;
    }): void;
    token?: string;
}) {
    return (
        <>
            <Field label="Auth">
                <select
                    onChange={(event) =>
                        onChange({ auth: event.target.value as typeof auth })
                    }
                    value={auth}
                >
                    <option value="none">none</option>
                    <option value="token">token</option>
                    <option value="oauth2">oauth2</option>
                </select>
            </Field>
            {auth === "token" ? (
                <Field label="Token">
                    <input
                        onChange={(event) =>
                            onChange({ token: event.target.value })
                        }
                        type="password"
                        value={token ?? ""}
                    />
                </Field>
            ) : null}
            {auth === "oauth2" ? (
                <>
                    <Field label="OAuth resource">
                        <input
                            onChange={(event) =>
                                onChange({
                                    oauth2: {
                                        documentationUrl:
                                            oauth2?.documentationUrl,
                                        requiredScopes:
                                            oauth2?.requiredScopes ?? [],
                                        resourceName: event.target.value,
                                    },
                                })
                            }
                            value={oauth2?.resourceName ?? ""}
                        />
                    </Field>
                    <Field label="OAuth scopes">
                        <input
                            onChange={(event) =>
                                onChange({
                                    oauth2: {
                                        documentationUrl:
                                            oauth2?.documentationUrl,
                                        requiredScopes: splitList(
                                            event.target.value,
                                        ),
                                        resourceName:
                                            oauth2?.resourceName ?? "",
                                    },
                                })
                            }
                            value={(oauth2?.requiredScopes ?? []).join(", ")}
                        />
                    </Field>
                </>
            ) : null}
        </>
    );
}

function Field({
    children,
    label,
}: {
    children: React.ReactNode;
    label: string;
}) {
    return (
        <label className="form-field">
            <span>{label}</span>
            {children}
        </label>
    );
}

function Check({
    checked,
    label,
    onChange,
}: {
    checked: boolean;
    label: string;
    onChange(value: boolean): void;
}) {
    return (
        <label className="check-field">
            <input
                checked={checked}
                onChange={(event) => onChange(event.target.checked)}
                type="checkbox"
            />
            <span>{label}</span>
        </label>
    );
}

function connectionDrafts(
    configView: Record<string, JsonValue> | undefined,
    instance: string | undefined,
): ConnectionDrafts {
    const entry = configInstances({
        readModel: { configView },
    } as WebState).find((candidate) => candidate.name === instance);
    const mcp = asRecord(entry?.mcp);
    return {
        instanceMcp: {
            auth: authMode(mcp?.auth),
            contextMode:
                mcp?.contextMode === "openai-session"
                    ? "openai-session"
                    : "explicit",
            enabled: mcp?.enabled !== false,
            oauth2: oauthDraft(mcp?.oauth2),
            path:
                typeof mcp?.path === "string"
                    ? mcp.path
                    : instance === undefined
                      ? "/mcp"
                      : `/${instance}/mcp`,
            token: typeof mcp?.token === "string" ? mcp.token : undefined,
        },
        mcp: configMcpPatch(configView?.mcp),
        web: configWebPatch(configView?.web),
    };
}

function configMcpPatch(value: JsonValue | undefined): ConfigMcpPatch {
    const record = asRecord(value);
    return {
        enabled: record?.enabled !== false,
        listenHost:
            typeof record?.listenHost === "string"
                ? record.listenHost
                : "127.0.0.1",
        listenPort:
            typeof record?.listenPort === "number" ? record.listenPort : 0,
        publicBaseUrl:
            typeof record?.publicBaseUrl === "string"
                ? record.publicBaseUrl
                : "",
    };
}

function configWebPatch(value: JsonValue | undefined): ConfigWebPatch {
    const record = asRecord(value);
    return {
        auth: authMode(record?.auth),
        enabled: record?.enabled !== false,
        listenHost:
            typeof record?.listenHost === "string"
                ? record.listenHost
                : "127.0.0.1",
        listenPort:
            typeof record?.listenPort === "number" ? record.listenPort : 0,
        oauth2: oauthDraft(record?.oauth2),
        publicBaseUrl:
            typeof record?.publicBaseUrl === "string"
                ? record.publicBaseUrl
                : "",
        token: typeof record?.token === "string" ? record.token : undefined,
    };
}

function fullValidationDraft(
    configView: Record<string, JsonValue> | undefined,
    selected: string,
    drafts: ConnectionDrafts,
): ConfigDraft {
    const instances = Array.isArray(configView?.instances)
        ? configView.instances.flatMap((entry) => {
              const record = asRecord(entry);
              if (record === undefined || typeof record.name !== "string")
                  return [];
              const clone = structuredClone(record) as Record<
                  string,
                  JsonValue
              >;
              const security = asRecord(clone.security);
              if (security !== undefined) {
                  delete security.effectiveMode;
                  clone.security = security;
              }
              if (record.name === selected)
                  clone.mcp = drafts.instanceMcp as unknown as JsonValue;
              return [clone as never];
          })
        : [];
    return {
        control: asRecord(configView?.control) as ConfigDraft["control"],
        instances,
        mcp: drafts.mcp as ConfigDraft["mcp"],
        web: drafts.web as ConfigDraft["web"],
    };
}

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

function asRecord(
    value: JsonValue | undefined,
): Record<string, JsonValue> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}

function authMode(value: JsonValue | undefined): "none" | "oauth2" | "token" {
    return value === "token" || value === "oauth2" ? value : "none";
}

function oauthDraft(value: JsonValue | undefined):
    | {
          documentationUrl?: string;
          requiredScopes?: string[];
          resourceName: string;
      }
    | undefined {
    const record = asRecord(value);
    if (record === undefined) return undefined;
    return {
        ...(typeof record.documentationUrl === "string"
            ? { documentationUrl: record.documentationUrl }
            : {}),
        requiredScopes: Array.isArray(record.requiredScopes)
            ? record.requiredScopes.filter(
                  (scope): scope is string => typeof scope === "string",
              )
            : [],
        resourceName:
            typeof record.resourceName === "string" ? record.resourceName : "",
    };
}

function localMcpEndpoint(instance: string, drafts: ConnectionDrafts): string {
    if (drafts.mcp.enabled === false || drafts.instanceMcp?.enabled === false)
        return "unavailable";
    return `http://${drafts.mcp.listenHost ?? "127.0.0.1"}:${drafts.mcp.listenPort ?? 0}${drafts.instanceMcp?.path ?? `/${instance}/mcp`}`;
}

function publicMcpEndpoint(drafts: ConnectionDrafts): string {
    if (drafts.mcp.enabled === false || drafts.instanceMcp?.enabled === false)
        return "unavailable";
    const base = String(drafts.mcp.publicBaseUrl ?? "").replace(/\/$/u, "");
    return base.length === 0
        ? "unavailable"
        : `${base}${drafts.instanceMcp?.path ?? "/mcp"}`;
}

function webEndpoint(drafts: ConnectionDrafts): string {
    if (drafts.web.enabled === false) return "disabled";
    const base = String(drafts.web.publicBaseUrl ?? "");
    return base.length > 0
        ? base
        : `http://${drafts.web.listenHost ?? "127.0.0.1"}:${drafts.web.listenPort ?? 0}`;
}

function parsePort(raw: string): number {
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 0;
}

function splitList(raw: string): string[] {
    return raw
        .split(/[\n,]/u)
        .map((value) => value.trim())
        .filter(Boolean);
}

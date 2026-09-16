import {
    type FormEvent,
    type ReactNode,
    useEffect,
    useMemo,
    useState,
} from "react";
import type {
    ApprovalPolicyRule,
    InstanceCreateDraft,
    InstanceCreateProvider,
    InstanceCreateSchema,
    InstanceCreateSummary,
    JsonValue,
} from "@portable-devshell/shared/browser";

import type { WebStore } from "../../state/Store.js";

interface CreateFormState {
    advancedJson: string;
    approvalMode: "allow" | "ask" | "deny" | "disabled";
    approvalRulesJson: string;
    enabled: boolean;
    extensions: string;
    mcpAuth: "none" | "oauth2" | "token";
    mcpContextMode: "explicit" | "openai-session";
    mcpEnabled: boolean;
    mcpOAuthDocumentationUrl: string;
    mcpOAuthResourceName: string;
    mcpOAuthScopes: string;
    mcpToken: string;
    name: string;
    provider: InstanceCreateProvider;
    providerJson: string;
    securityMode: "disabled" | "workspace";
    workspaceEnabled: boolean;
}

export function InstanceCreate({
    disabled,
    onCancel,
    onCreated,
    store,
}: {
    disabled: boolean;
    onCancel(): void;
    onCreated(enrollment?: string): void;
    store: WebStore;
}) {
    const [schema, setSchema] = useState<InstanceCreateSchema>();
    const [form, setForm] = useState<CreateFormState>(() => emptyForm());
    const [schemaError, setSchemaError] = useState<string>();
    const [validationError, setValidationError] = useState<string>();
    const [summary, setSummary] = useState<InstanceCreateSummary>();
    const operation = `instance-create:${form.name.trim() || "new"}`;
    const busy = store.state.operations[operation] !== undefined;

    useEffect(() => {
        let active = true;
        void store
            .getInstanceCreateSchema()
            .then((next) => {
                if (!active) return;
                setSchema(next);
                setForm(formFromSchema(next));
                setSchemaError(undefined);
            })
            .catch((error: unknown) => {
                if (!active) return;
                setSchemaError(readError(error));
            });
        return () => {
            active = false;
        };
    }, [store]);

    const preview = useMemo(() => {
        try {
            return buildDraft(form, schema);
        } catch {
            return undefined;
        }
    }, [form, schema]);

    function update<K extends keyof CreateFormState>(
        key: K,
        value: CreateFormState[K],
    ): void {
        setForm((current) => ({ ...current, [key]: value }));
        setSummary(undefined);
        setValidationError(undefined);
    }

    function changeProvider(provider: InstanceCreateProvider): void {
        setForm((current) => ({
            ...current,
            provider,
            providerJson: providerDefaults(provider, current.name, schema),
        }));
        setSummary(undefined);
        setValidationError(undefined);
    }

    async function validate(): Promise<InstanceCreateDraft | undefined> {
        try {
            const draft = buildDraft(form, schema);
            const normalized = await store.validateInstanceCreate(draft);
            setSummary(normalized);
            setValidationError(undefined);
            return draft;
        } catch (error) {
            setSummary(undefined);
            setValidationError(readError(error));
            return undefined;
        }
    }

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const draft = await validate();
        if (draft === undefined) return;
        const result = await store.createInstance(draft);
        if (!result.succeeded) {
            setValidationError(
                store.state.error ?? "Instance could not be created.",
            );
            return;
        }
        onCreated(result.enrollment);
    }

    if (schemaError !== undefined) {
        return (
            <article className="detail instance-create-panel">
                <h3>Create instance</h3>
                <p className="error" role="alert">
                    {schemaError}
                </p>
                <button onClick={onCancel} type="button">
                    Back to instances
                </button>
            </article>
        );
    }
    if (schema === undefined) {
        return (
            <article className="detail instance-create-panel">
                <h3>Create instance</h3>
                <p className="hint" role="status">
                    Loading create schema…
                </p>
            </article>
        );
    }

    return (
        <article className="detail instance-create-panel">
            <button className="back" onClick={onCancel} type="button">
                Back to instances
            </button>
            <h3>Create instance</h3>
            <form
                aria-busy={busy}
                className="instance-create-form"
                onSubmit={(event) => void submit(event)}
            >
                <fieldset disabled={disabled || busy}>
                    <legend>Identity and provider</legend>
                    <div className="form-grid">
                        <Field label="Name">
                            <input
                                autoFocus
                                onChange={(event) => {
                                    const oldDefault = providerDefaults(
                                        form.provider,
                                        form.name,
                                        schema,
                                    );
                                    const name = event.target.value;
                                    setForm((current) => ({
                                        ...current,
                                        name,
                                        providerJson:
                                            current.providerJson === oldDefault
                                                ? providerDefaults(
                                                      current.provider,
                                                      name,
                                                      schema,
                                                  )
                                                : current.providerJson,
                                    }));
                                    setSummary(undefined);
                                    setValidationError(undefined);
                                }}
                                required
                                value={form.name}
                            />
                        </Field>
                        <Field label="Provider">
                            <select
                                onChange={(event) =>
                                    changeProvider(
                                        event.target
                                            .value as InstanceCreateProvider,
                                    )
                                }
                                value={form.provider}
                            >
                                {schema.providers.map((provider) => (
                                    <option key={provider} value={provider}>
                                        {provider}
                                    </option>
                                ))}
                            </select>
                        </Field>
                        <Check
                            checked={form.enabled}
                            label="Enabled after creation"
                            onChange={(value) => update("enabled", value)}
                        />
                        <Check
                            checked={form.workspaceEnabled}
                            label="Workspace enabled"
                            onChange={(value) =>
                                update("workspaceEnabled", value)
                            }
                        />
                        <Field label="Provider settings JSON" wide>
                            <textarea
                                aria-describedby="provider-json-help"
                                onChange={(event) =>
                                    update("providerJson", event.target.value)
                                }
                                rows={5}
                                value={form.providerJson}
                            />
                            <small className="hint" id="provider-json-help">
                                SSH uses <code>ssh.command</code>; Docker/Podman
                                uses the shared <code>container</code> schema
                                and optional binary path. Local/Reverse need no
                                extra fields.
                            </small>
                        </Field>
                    </div>
                </fieldset>

                <fieldset disabled={disabled || busy}>
                    <legend>MCP and model access</legend>
                    <div className="form-grid">
                        <Check
                            checked={form.mcpEnabled}
                            label="MCP enabled"
                            onChange={(value) => update("mcpEnabled", value)}
                        />
                        <Field label="Context mode">
                            <select
                                onChange={(event) =>
                                    update(
                                        "mcpContextMode",
                                        event.target
                                            .value as CreateFormState["mcpContextMode"],
                                    )
                                }
                                value={form.mcpContextMode}
                            >
                                <option value="explicit">explicit</option>
                                <option value="openai-session">
                                    openai-session
                                </option>
                            </select>
                        </Field>
                        <Field label="MCP auth">
                            <select
                                onChange={(event) =>
                                    update(
                                        "mcpAuth",
                                        event.target
                                            .value as CreateFormState["mcpAuth"],
                                    )
                                }
                                value={form.mcpAuth}
                            >
                                <option value="none">none</option>
                                <option value="token">token</option>
                                <option value="oauth2">oauth2</option>
                            </select>
                        </Field>
                        {form.mcpAuth === "token" ? (
                            <Field label="MCP token">
                                <input
                                    onChange={(event) =>
                                        update("mcpToken", event.target.value)
                                    }
                                    type="password"
                                    value={form.mcpToken}
                                />
                            </Field>
                        ) : null}
                        {form.mcpAuth === "oauth2" ? (
                            <>
                                <Field label="OAuth resource">
                                    <input
                                        onChange={(event) =>
                                            update(
                                                "mcpOAuthResourceName",
                                                event.target.value,
                                            )
                                        }
                                        value={form.mcpOAuthResourceName}
                                    />
                                </Field>
                                <Field label="OAuth scopes">
                                    <input
                                        onChange={(event) =>
                                            update(
                                                "mcpOAuthScopes",
                                                event.target.value,
                                            )
                                        }
                                        placeholder="scope-a, scope-b"
                                        value={form.mcpOAuthScopes}
                                    />
                                </Field>
                                <Field label="OAuth documentation URL">
                                    <input
                                        onChange={(event) =>
                                            update(
                                                "mcpOAuthDocumentationUrl",
                                                event.target.value,
                                            )
                                        }
                                        value={form.mcpOAuthDocumentationUrl}
                                    />
                                </Field>
                            </>
                        ) : null}
                        <Field label="Model extensions">
                            <input
                                onChange={(event) =>
                                    update("extensions", event.target.value)
                                }
                                placeholder="instance, another-extension"
                                value={form.extensions}
                            />
                        </Field>
                    </div>
                </fieldset>

                <fieldset disabled={disabled || busy}>
                    <legend>Security and approval</legend>
                    <div className="form-grid">
                        <Field label="Security mode">
                            <select
                                onChange={(event) =>
                                    update(
                                        "securityMode",
                                        event.target
                                            .value as CreateFormState["securityMode"],
                                    )
                                }
                                value={form.securityMode}
                            >
                                <option value="disabled">disabled</option>
                                <option value="workspace">workspace</option>
                            </select>
                        </Field>
                        <Field label="Approval mode">
                            <select
                                onChange={(event) =>
                                    update(
                                        "approvalMode",
                                        event.target
                                            .value as CreateFormState["approvalMode"],
                                    )
                                }
                                value={form.approvalMode}
                            >
                                <option value="disabled">disabled</option>
                                <option value="allow">allow</option>
                                <option value="ask">ask</option>
                                <option value="deny">deny</option>
                            </select>
                        </Field>
                        <Field label="Approval rules JSON" wide>
                            <textarea
                                onChange={(event) =>
                                    update(
                                        "approvalRulesJson",
                                        event.target.value,
                                    )
                                }
                                placeholder='[{"decision":"ask","match":"exact","source":"mcp","toolName":"bash_run"}]'
                                rows={4}
                                value={form.approvalRulesJson}
                            />
                        </Field>
                    </div>
                </fieldset>

                <details>
                    <summary>Advanced instance settings</summary>
                    <fieldset disabled={disabled || busy}>
                        <Field label="Additional instance draft JSON" wide>
                            <textarea
                                aria-describedby="advanced-json-help"
                                onChange={(event) =>
                                    update("advancedJson", event.target.value)
                                }
                                placeholder='{"env":{"KEY":"value"},"logs":{"retentionDays":7},"tools":{"scheduler":{"maxRunning":4}}}'
                                rows={8}
                                value={form.advancedJson}
                            />
                            <small className="hint" id="advanced-json-help">
                                Supports the remaining shared instance draft
                                fields, including env, logs and tool scheduler
                                settings. Core fields above remain
                                authoritative.
                            </small>
                        </Field>
                    </fieldset>
                </details>

                {validationError === undefined ? null : (
                    <p className="error" role="alert">
                        {validationError}
                    </p>
                )}
                {summary === undefined ? null : (
                    <details className="validation-summary" open>
                        <summary>Validated configuration</summary>
                        <pre>
                            {JSON.stringify(redactSummary(summary), null, 2)}
                        </pre>
                    </details>
                )}
                <div className="actions">
                    <button disabled={busy} onClick={onCancel} type="button">
                        Cancel
                    </button>
                    <button
                        disabled={busy || preview === undefined}
                        onClick={() => void validate()}
                        type="button"
                    >
                        Validate
                    </button>
                    <button
                        className="primary"
                        disabled={busy || preview === undefined}
                        type="submit"
                    >
                        {busy ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </article>
    );
}

function Field({
    children,
    label,
    wide = false,
}: {
    children: ReactNode;
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

function emptyForm(): CreateFormState {
    return {
        advancedJson: "",
        approvalMode: "disabled",
        approvalRulesJson: "",
        enabled: true,
        extensions: "instance",
        mcpAuth: "none",
        mcpContextMode: "explicit",
        mcpEnabled: true,
        mcpOAuthDocumentationUrl: "",
        mcpOAuthResourceName: "",
        mcpOAuthScopes: "",
        mcpToken: "",
        name: "",
        provider: "local",
        providerJson: "{}",
        securityMode: "disabled",
        workspaceEnabled: true,
    };
}

function formFromSchema(schema: InstanceCreateSchema): CreateFormState {
    const form = {
        ...emptyForm(),
        enabled: schema.defaultEnabled,
        extensions: schema.defaultModelExtensions.join(", "),
        mcpContextMode: schema.defaultMcpContextMode ?? "explicit",
        mcpEnabled: schema.defaultMcpEnabled,
        provider: schema.defaultProvider,
        securityMode: schema.defaultSecurityMode,
    };
    return {
        ...form,
        providerJson: providerDefaults(form.provider, form.name, schema),
    };
}

function providerDefaults(
    provider: InstanceCreateProvider,
    name: string,
    schema: InstanceCreateSchema | undefined,
): string {
    if (provider === "ssh")
        return JSON.stringify({ ssh: { command: "" } }, null, 2);
    if (provider !== "docker" && provider !== "podman") return "{}";
    const preset = schema?.container.presets[0];
    const containerName =
        name.trim().length === 0
            ? "devshell-instance"
            : `devshell-${name.trim()}`;
    const mode = schema?.container.defaultMode ?? "existingImage";
    const container =
        mode === "preset"
            ? {
                  containerName,
                  image: preset?.image ?? "",
                  mode,
                  preset: preset?.preset ?? "",
              }
            : mode === "dockerfile"
              ? {
                    build: { context: "", tag: `${containerName}:latest` },
                    containerName,
                    mode,
                }
              : mode === "compose"
                ? { compose: { file: "", service: "" }, mode }
                : mode === "existingStoppedContainer"
                  ? { adoptLifecycle: false, containerName, mode }
                  : { containerName, image: "", mode: "existingImage" };
    return JSON.stringify({ container }, null, 2);
}

function buildDraft(
    form: CreateFormState,
    schema: InstanceCreateSchema | undefined,
): InstanceCreateDraft {
    if (schema === undefined) throw new Error("Create schema is unavailable.");
    const name = form.name.trim();
    if (name.length === 0) throw new Error("Instance name is required.");
    const advanced = parseObject(
        form.advancedJson,
        "Advanced instance settings",
    );
    const provider = parseObject(form.providerJson, "Provider settings");
    const rules = parseOptionalJson<ApprovalPolicyRule[]>(
        form.approvalRulesJson,
        "Approval rules",
    );
    const draft = {
        ...advanced,
        ...provider,
        approvalPolicy: {
            mode: form.approvalMode,
            ...(rules === undefined ? {} : { rules }),
        },
        enabled: form.enabled,
        extensions: { model: splitList(form.extensions) },
        mcp: {
            auth: form.mcpAuth,
            contextMode: form.mcpContextMode,
            enabled: form.mcpEnabled,
            ...(form.mcpAuth === "token"
                ? { token: form.mcpToken }
                : form.mcpAuth === "oauth2"
                  ? {
                        oauth2: {
                            resourceName: form.mcpOAuthResourceName.trim(),
                            requiredScopes: splitList(form.mcpOAuthScopes),
                            ...(form.mcpOAuthDocumentationUrl.trim().length ===
                            0
                                ? {}
                                : {
                                      documentationUrl:
                                          form.mcpOAuthDocumentationUrl.trim(),
                                  }),
                        },
                    }
                  : {}),
        },
        name,
        provider: form.provider,
        security: { mode: form.securityMode },
        workspace: { enabled: form.workspaceEnabled },
    };
    return draft as InstanceCreateDraft;
}

function parseObject(raw: string, label: string): Record<string, JsonValue> {
    if (raw.trim().length === 0) return {};
    const value = parseOptionalJson<unknown>(raw, label);
    if (typeof value !== "object" || value === null || Array.isArray(value))
        throw new Error(`${label} must be a JSON object.`);
    return value as Record<string, JsonValue>;
}

function parseOptionalJson<T>(raw: string, label: string): T | undefined {
    if (raw.trim().length === 0) return undefined;
    try {
        return JSON.parse(raw) as T;
    } catch {
        throw new Error(`${label} must be valid JSON.`);
    }
}

function splitList(raw: string): string[] {
    return raw
        .split(/[\n,]/u)
        .map((value) => value.trim())
        .filter(
            (value, index, values) =>
                value.length > 0 && values.indexOf(value) === index,
        );
}

function redactSummary(summary: InstanceCreateSummary): unknown {
    const clone = structuredClone(summary) as unknown as Record<
        string,
        unknown
    >;
    const mcp = clone.mcp;
    if (typeof mcp === "object" && mcp !== null && !Array.isArray(mcp)) {
        const auth = (mcp as Record<string, unknown>).auth;
        if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
            const authRecord = auth as Record<string, unknown>;
            if ("token" in authRecord) authRecord.token = "***";
        }
    }
    return clone;
}

function readError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type {
    InstanceCreateDraft,
    InstanceCreateProvider,
    InstanceCreateSchema,
} from "@portable-devshell/shared/browser";

import type { WebStore } from "../../state/Store.js";

type ContainerMode = InstanceCreateSchema["container"]["defaultMode"];

interface CreateFormState {
    buildContext: string;
    composeFile: string;
    composeService: string;
    containerMode: ContainerMode;
    existingContainer: string;
    image: string;
    name: string;
    preset: string;
    provider: InstanceCreateProvider;
    sshHost: string;
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

    function update<K extends keyof CreateFormState>(
        key: K,
        value: CreateFormState[K],
    ): void {
        setForm((current) => ({ ...current, [key]: value }));
        setValidationError(undefined);
    }

    function changeProvider(provider: InstanceCreateProvider): void {
        setForm((current) => ({
            ...current,
            provider,
            ...(provider === "ssh" && current.sshHost.length === 0
                ? { sshHost: schema?.sshHosts?.[0] ?? "" }
                : {}),
        }));
        setValidationError(undefined);
    }

    async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        try {
            const draft = buildDraft(form, schema);
            const result = await store.createInstance(draft);
            if (!result.succeeded) {
                setValidationError(
                    store.state.error ?? "Instance could not be created.",
                );
                return;
            }
            setValidationError(undefined);
            onCreated(result.enrollment);
        } catch (error) {
            setValidationError(readError(error));
        }
    }

    if (schemaError !== undefined) {
        return (
            <article className="detail instance-create-panel">
                <h3>Create an instance</h3>
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
                <h3>Create an instance</h3>
                <p className="hint" role="status">
                    Loading…
                </p>
            </article>
        );
    }

    const containerProviders = schema.providers.filter(
        (provider) => provider === "docker" || provider === "podman",
    );
    const isContainer = form.provider === "docker" || form.provider === "podman";

    return (
        <article className="detail instance-create-panel">
            <button className="back" onClick={onCancel} type="button">
                Back to instances
            </button>
            <h3>Create an instance</h3>
            <form
                aria-busy={busy}
                className="instance-create-form"
                onSubmit={(event) => void submit(event)}
            >
                <fieldset disabled={disabled || busy}>
                    <Field label="Name">
                        <input
                            autoFocus
                            onChange={(event) => update("name", event.target.value)}
                            required
                            value={form.name}
                        />
                    </Field>
                </fieldset>

                <fieldset disabled={disabled || busy}>
                    <legend>Where should DevShell run?</legend>
                    <div className="provider-choice-grid">
                        {schema.providers.includes("local") ? (
                            <ProviderChoice
                                checked={form.provider === "local"}
                                description="Run directly on this machine"
                                label="This computer"
                                onSelect={() => changeProvider("local")}
                            />
                        ) : null}
                        {schema.providers.includes("ssh") ? (
                            <ProviderChoice
                                checked={form.provider === "ssh"}
                                description="Connect to another machine"
                                label="SSH"
                                onSelect={() => changeProvider("ssh")}
                            />
                        ) : null}
                        {containerProviders.length > 0 ? (
                            <ProviderChoice
                                checked={isContainer}
                                description="Run in a container"
                                label="Docker / Podman"
                                onSelect={() =>
                                    changeProvider(
                                        isContainer
                                            ? form.provider
                                            : (containerProviders[0] ?? "docker"),
                                    )
                                }
                            />
                        ) : null}
                        {schema.providers.includes("reverse") ? (
                            <ProviderChoice
                                checked={form.provider === "reverse"}
                                description="Let another machine connect back"
                                label="Reverse connection"
                                onSelect={() => changeProvider("reverse")}
                            />
                        ) : null}
                    </div>
                </fieldset>

                {form.provider === "ssh" ? (
                    <fieldset disabled={disabled || busy}>
                        <legend>SSH</legend>
                        <Field label="SSH host">
                            <input
                                list="instance-create-ssh-hosts"
                                onChange={(event) => {
                                    const sshHost = event.target.value;
                                    setForm((current) => ({
                                        ...current,
                                        sshHost,
                                        name:
                                            current.name.length === 0
                                                ? sshHost
                                                : current.name,
                                    }));
                                    setValidationError(undefined);
                                }}
                                placeholder="Host from ~/.ssh/config"
                                required
                                value={form.sshHost}
                            />
                            <datalist id="instance-create-ssh-hosts">
                                {(schema.sshHosts ?? []).map((host) => (
                                    <option key={host} value={host} />
                                ))}
                            </datalist>
                            <small className="hint">
                                Uses your OpenSSH config, including HostName,
                                User, Port, IdentityFile and ProxyJump.
                            </small>
                        </Field>
                    </fieldset>
                ) : null}

                {isContainer ? (
                    <fieldset disabled={disabled || busy}>
                        <legend>Container</legend>
                        <div className="form-grid">
                            {containerProviders.length > 1 ? (
                                <Field label="Engine">
                                    <select
                                        onChange={(event) =>
                                            changeProvider(
                                                event.target
                                                    .value as InstanceCreateProvider,
                                            )
                                        }
                                        value={form.provider}
                                    >
                                        {containerProviders.map((provider) => (
                                            <option key={provider} value={provider}>
                                                {provider === "docker"
                                                    ? "Docker"
                                                    : "Podman"}
                                            </option>
                                        ))}
                                    </select>
                                </Field>
                            ) : null}
                            <Field label="Environment">
                                <select
                                    onChange={(event) =>
                                        update(
                                            "containerMode",
                                            event.target.value as ContainerMode,
                                        )
                                    }
                                    value={form.containerMode}
                                >
                                    {schema.container.modes.map((mode) => (
                                        <option key={mode} value={mode}>
                                            {containerModeLabel(mode)}
                                        </option>
                                    ))}
                                </select>
                            </Field>
                            <ContainerFields
                                form={form}
                                schema={schema}
                                update={update}
                            />
                        </div>
                    </fieldset>
                ) : null}

                {validationError === undefined ? null : (
                    <p className="error" role="alert">
                        {validationError}
                    </p>
                )}
                <div className="actions">
                    <button disabled={busy} onClick={onCancel} type="button">
                        Cancel
                    </button>
                    <button
                        className="primary"
                        disabled={disabled || busy}
                        type="submit"
                    >
                        {busy ? "Creating…" : "Create"}
                    </button>
                </div>
            </form>
        </article>
    );
}

function ContainerFields({
    form,
    schema,
    update,
}: {
    form: CreateFormState;
    schema: InstanceCreateSchema;
    update<K extends keyof CreateFormState>(key: K, value: CreateFormState[K]): void;
}) {
    switch (form.containerMode) {
        case "preset":
            return (
                <Field label="Preset">
                    <select
                        onChange={(event) => update("preset", event.target.value)}
                        value={form.preset}
                    >
                        {schema.container.presets.map((preset) => (
                            <option key={preset.preset} value={preset.preset}>
                                {preset.preset}
                            </option>
                        ))}
                    </select>
                </Field>
            );
        case "existingImage":
            return (
                <Field label="Image">
                    <input
                        onChange={(event) => update("image", event.target.value)}
                        placeholder="ubuntu:24.04"
                        required
                        value={form.image}
                    />
                </Field>
            );
        case "existingStoppedContainer":
            return (
                <Field label="Existing container">
                    <input
                        onChange={(event) =>
                            update("existingContainer", event.target.value)
                        }
                        required
                        value={form.existingContainer}
                    />
                </Field>
            );
        case "dockerfile":
            return (
                <Field label="Build context">
                    <input
                        onChange={(event) =>
                            update("buildContext", event.target.value)
                        }
                        placeholder="."
                        required
                        value={form.buildContext}
                    />
                </Field>
            );
        case "compose":
            return (
                <>
                    <Field label="Compose file">
                        <input
                            onChange={(event) =>
                                update("composeFile", event.target.value)
                            }
                            placeholder="compose.yaml"
                            required
                            value={form.composeFile}
                        />
                    </Field>
                    <Field label="Service">
                        <input
                            onChange={(event) =>
                                update("composeService", event.target.value)
                            }
                            required
                            value={form.composeService}
                        />
                    </Field>
                </>
            );
    }
}

function ProviderChoice({
    checked,
    description,
    label,
    onSelect,
}: {
    checked: boolean;
    description: string;
    label: string;
    onSelect(): void;
}) {
    return (
        <label className={checked ? "provider-choice selected" : "provider-choice"}>
            <input
                checked={checked}
                name="instance-provider"
                onChange={onSelect}
                type="radio"
            />
            <span>
                <strong>{label}</strong>
                <small>{description}</small>
            </span>
        </label>
    );
}

function Field({ children, label }: { children: ReactNode; label: string }) {
    return (
        <label className="form-field">
            <span>{label}</span>
            {children}
        </label>
    );
}

function emptyForm(): CreateFormState {
    return {
        buildContext: "",
        composeFile: "",
        composeService: "",
        containerMode: "preset",
        existingContainer: "",
        image: "",
        name: "",
        preset: "",
        provider: "local",
        sshHost: "",
    };
}

function formFromSchema(schema: InstanceCreateSchema): CreateFormState {
    return {
        ...emptyForm(),
        containerMode: schema.container.defaultMode,
        preset: schema.container.presets[0]?.preset ?? "",
        provider: schema.defaultProvider,
        sshHost: schema.sshHosts?.[0] ?? "",
    };
}

function buildDraft(
    form: CreateFormState,
    schema: InstanceCreateSchema | undefined,
): InstanceCreateDraft {
    if (schema === undefined) throw new Error("Create schema is unavailable.");
    const name = required(form.name, "Instance name");
    const draft: Record<string, unknown> = {
        name,
        provider: form.provider,
    };
    if (form.provider === "ssh") {
        const host = required(form.sshHost, "SSH host");
        draft.ssh = { command: `ssh ${quoteArgument(host)}` };
    }
    if (form.provider === "docker" || form.provider === "podman") {
        switch (form.containerMode) {
            case "preset":
                draft.container = {
                    mode: "preset",
                    preset: required(form.preset, "Container preset"),
                };
                break;
            case "existingImage":
                draft.container = {
                    image: required(form.image, "Container image"),
                    mode: "existingImage",
                };
                break;
            case "existingStoppedContainer":
                draft.container = {
                    containerName: required(
                        form.existingContainer,
                        "Existing container",
                    ),
                    mode: "existingStoppedContainer",
                };
                break;
            case "dockerfile":
                draft.container = {
                    build: {
                        context: required(form.buildContext, "Build context"),
                    },
                    mode: "dockerfile",
                };
                break;
            case "compose":
                draft.container = {
                    compose: {
                        file: required(form.composeFile, "Compose file"),
                        service: required(form.composeService, "Compose service"),
                    },
                    mode: "compose",
                };
                break;
        }
    }
    return draft as unknown as InstanceCreateDraft;
}

function required(value: string, label: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) throw new Error(`${label} is required.`);
    return trimmed;
}

function quoteArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function containerModeLabel(mode: ContainerMode): string {
    switch (mode) {
        case "preset":
            return "Distro preset";
        case "existingImage":
            return "Existing image";
        case "existingStoppedContainer":
            return "Existing stopped container";
        case "dockerfile":
            return "Dockerfile";
        case "compose":
            return "Compose service";
        default:
            return mode;
    }
}

function readError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

import type { ApprovalPolicy } from "../dto/tool/DtoToolApproval.js";
import type { InstanceContainerConfig } from "../dto/instance/DtoInstanceCreate.js";
import { configInputError } from "./ConfigIssue.js";
import type {
    ConfigContainerDraft,
    ConfigDraft,
    ConfigGlobalDraft,
    ConfigInstanceDraft,
    ConfigInstancePatch,
    ConfigMcpAuthDraft,
    ConfigMcpPatch,
    ConfigNormalizeContext,
    ConfigView,
    ControlConfig,
    ControlGlobalConfig,
    ControlInstanceConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthConfig
} from "./ConfigModel.js";
import { defaultConfigNormalizeContext } from "./ConfigModel.js";

export function createDefaultControlConfig(): ControlConfig {
    return normalizeConfigDraft({ instances: [] });
}

export function normalizeConfigDraft(
    draft: ConfigDraft,
    context: ConfigNormalizeContext = defaultConfigNormalizeContext
): ControlConfig {
    const global = normalizeConfigGlobalDraft(draft);
    return {
        ...global,
        instances: (draft.instances ?? []).map((instance) => normalizeConfigInstanceDraft(instance, context))
    };
}

export function normalizeConfigGlobalDraft(draft: ConfigGlobalDraft): ControlGlobalConfig {
    const auth = normalizeMcpAuth(draft.mcp?.auth);
    return {
        control: {
            logLevel: draft.control?.logLevel ?? "info"
        },
        mcp: {
            auth,
            enabled: draft.mcp?.enabled ?? false,
            listenHost: draft.mcp?.listenHost ?? "127.0.0.1",
            listenPort: draft.mcp?.listenPort ?? 17890,
            publicBaseUrl:
                draft.mcp?.publicBaseUrl === null
                    ? undefined
                    : draft.mcp?.publicBaseUrl ?? "http://127.0.0.1:17890"
        }
    };
}

export function normalizeConfigInstanceDraft(
    draft: ConfigInstanceDraft,
    context: ConfigNormalizeContext = defaultConfigNormalizeContext
): ControlInstanceConfig {
    const workspace = draft.workspace;
    if (workspace === undefined) {
        throw configInputError("normalize", ["workspace"], "config.instance.workspaceRequired", "is required");
    }

    const expectedMcpPath = `/${draft.name}/mcp`;
    if (draft.mcp?.path !== undefined && draft.mcp.path !== expectedMcpPath) {
        throw configInputError(
            "normalize",
            ["mcp", "path"],
            "config.instance.mcpPath",
            `must be ${expectedMcpPath}`
        );
    }

    const common = {
        approvalPolicy: cloneApprovalPolicy(draft.approvalPolicy),
        enabled: draft.enabled ?? context.defaultEnabled,
        env: cloneNonEmptyRecord(draft.env),
        logs: cloneOptionalRecord(draft.logs),
        mcp: {
            enabled: draft.mcp?.enabled ?? context.defaultMcpEnabled,
            path: expectedMcpPath,
            tools: {
                capabilities: deduplicate(draft.mcp?.tools?.capabilities ?? context.defaultMcpCapabilities),
                groups: deduplicate(draft.mcp?.tools?.groups ?? context.defaultMcpGroups)
            }
        },
        name: draft.name,
        security: {
            mode: draft.security?.mode ?? context.defaultSecurityMode
        },
        tools: cloneTools(draft.tools),
        workspace
    };

    switch (draft.provider) {
        case "local":
        case "reverse":
            assertAbsent(draft.container, ["container"], draft.provider);
            assertAbsent(draft.ssh, ["ssh"], draft.provider);
            assertAbsent(draft.dockerBinary, ["dockerBinary"], draft.provider);
            assertAbsent(draft.podmanBinary, ["podmanBinary"], draft.provider);
            return {
                ...common,
                provider: draft.provider
            };
        case "ssh": {
            assertAbsent(draft.container, ["container"], draft.provider);
            assertAbsent(draft.dockerBinary, ["dockerBinary"], draft.provider);
            assertAbsent(draft.podmanBinary, ["podmanBinary"], draft.provider);
            if (draft.ssh?.command === undefined) {
                throw configInputError("normalize", ["ssh", "command"], "config.instance.sshCommandRequired", "is required");
            }
            return {
                ...common,
                provider: "ssh",
                ssh: {
                    command: draft.ssh.command
                }
            };
        }
        case "docker":
            assertAbsent(draft.ssh, ["ssh"], draft.provider);
            assertAbsent(draft.podmanBinary, ["podmanBinary"], draft.provider);
            if (draft.container === undefined) {
                throw configInputError("normalize", ["container"], "config.instance.containerRequired", "is required for docker");
            }
            return {
                ...common,
                container: normalizeContainer(draft.container, draft.name, context),
                dockerBinary: draft.dockerBinary,
                provider: "docker"
            };
        case "podman":
            assertAbsent(draft.ssh, ["ssh"], draft.provider);
            assertAbsent(draft.dockerBinary, ["dockerBinary"], draft.provider);
            if (draft.container === undefined) {
                throw configInputError("normalize", ["container"], "config.instance.containerRequired", "is required for podman");
            }
            return {
                ...common,
                container: normalizeContainer(draft.container, draft.name, context),
                podmanBinary: draft.podmanBinary,
                provider: "podman"
            };
    }
}

export function applyConfigInstancePatch(
    current: ControlInstanceConfig,
    patch: ConfigInstancePatch
): ConfigInstanceDraft {
    const provider = patch.provider ?? current.provider;
    const providerChanged = provider !== current.provider;
    const base = toConfigInstanceDraft(current);

    return {
        ...base,
        approvalPolicy: applyNullable(patch.approvalPolicy, base.approvalPolicy),
        container: providerChanged
            ? applyNullable(patch.container, undefined)
            : applyNullable(patch.container, base.container),
        dockerBinary: providerChanged
            ? applyNullable(patch.dockerBinary, undefined)
            : applyNullable(patch.dockerBinary, base.dockerBinary),
        enabled: patch.enabled ?? base.enabled,
        env: applyNullable(patch.env, base.env),
        logs: applyNullable(patch.logs, base.logs),
        mcp:
            patch.mcp === undefined
                ? base.mcp
                : {
                      enabled: patch.mcp.enabled ?? base.mcp?.enabled,
                      path: applyNullable(patch.mcp.path, base.mcp?.path),
                      tools:
                          patch.mcp.tools === undefined
                              ? base.mcp?.tools
                              : {
                                    capabilities:
                                        patch.mcp.tools.capabilities ?? base.mcp?.tools?.capabilities,
                                    groups: patch.mcp.tools.groups ?? base.mcp?.tools?.groups
                                }
                  },
        podmanBinary: providerChanged
            ? applyNullable(patch.podmanBinary, undefined)
            : applyNullable(patch.podmanBinary, base.podmanBinary),
        provider,
        security:
            patch.security === undefined
                ? base.security
                : {
                      mode: patch.security.mode ?? base.security?.mode
                  },
        ssh: providerChanged ? applyNullable(patch.ssh, undefined) : applyNullable(patch.ssh, base.ssh),
        tools: applyNullable(patch.tools, base.tools),
        workspace: patch.workspace ?? base.workspace
    };
}

export function applyConfigMcpPatch(
    current: ControlGlobalConfig["mcp"],
    patch: ConfigMcpPatch
): ConfigGlobalDraft["mcp"] {
    return {
        auth: patch.auth ?? toMcpAuthDraft(current.auth),
        enabled: patch.enabled ?? current.enabled,
        listenHost: patch.listenHost ?? current.listenHost,
        listenPort: patch.listenPort ?? current.listenPort,
        publicBaseUrl: patch.publicBaseUrl === undefined ? current.publicBaseUrl : patch.publicBaseUrl
    };
}

export function toConfigView(config: ControlConfig): ConfigView {
    return {
        control: { ...config.control },
        instances: config.instances.map((instance) => ({
            ...cloneInstance(instance),
            security: {
                effectiveMode: instance.security.mode,
                mode: instance.security.mode
            }
        })),
        mcp: {
            ...config.mcp,
            auth: cloneMcpAuth(config.mcp.auth)
        }
    };
}

export function toConfigInstanceDraft(instance: ControlInstanceConfig): ConfigInstanceDraft {
    return {
        approvalPolicy: cloneApprovalPolicy(instance.approvalPolicy),
        container: instance.container === undefined ? undefined : cloneContainer(instance.container),
        dockerBinary: instance.dockerBinary,
        enabled: instance.enabled,
        env: cloneOptionalRecord(instance.env),
        logs: cloneOptionalRecord(instance.logs),
        mcp: {
            enabled: instance.mcp.enabled,
            path: instance.mcp.path,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        name: instance.name,
        podmanBinary: instance.podmanBinary,
        provider: instance.provider,
        security: { ...instance.security },
        ssh: instance.ssh === undefined ? undefined : { ...instance.ssh },
        tools: cloneTools(instance.tools),
        workspace: instance.workspace
    };
}

function normalizeMcpAuth(draft: ConfigMcpAuthDraft | undefined): ControlMcpAuthConfig {
    if (draft === undefined || draft.mode === "none") return { mode: "none" };
    if (draft.mode === "token") return { mode: "token" };
    return {
        mode: "oauth2",
        oauth2: {
            audience: draft.oauth2.audience,
            documentationUrl: draft.oauth2.documentationUrl,
            issuer: draft.oauth2.issuer,
            jwksUri: draft.oauth2.jwksUri,
            requiredScopes: deduplicate(draft.oauth2.requiredScopes ?? []),
            resourceName: draft.oauth2.resourceName
        }
    };
}

function normalizeContainer(
    draft: ConfigContainerDraft,
    instanceName: string,
    context: ConfigNormalizeContext
): InstanceContainerConfig {
    const defaultContainerName = `devshell-${instanceName}`;
    switch (draft.mode) {
        case "preset": {
            const preset = context.containerPresets.find((entry) => entry.preset === draft.preset);
            if (preset === undefined) {
                throw configInputError(
                    "normalize",
                    ["container", "preset"],
                    "config.container.presetUnknown",
                    `must be one of ${context.containerPresets.map((entry) => entry.preset).join(", ")}`
                );
            }
            return {
                ...normalizeManagedContainer(draft, defaultContainerName),
                image: draft.image ?? preset.image,
                mode: "preset",
                preset: draft.preset
            };
        }
        case "dockerfile":
            return {
                ...normalizeManagedContainer(draft, defaultContainerName),
                build: {
                    context: draft.build.context,
                    dockerfile: draft.build.dockerfile,
                    tag: draft.build.tag ?? `devshell-${instanceName}:latest`
                },
                mode: "dockerfile"
            };
        case "compose":
            return {
                compose: { ...draft.compose },
                mode: "compose"
            };
        case "existingImage":
            return {
                ...normalizeManagedContainer(draft, defaultContainerName),
                image: draft.image,
                mode: "existingImage"
            };
        case "existingStoppedContainer":
            return {
                adoptLifecycle: draft.adoptLifecycle,
                containerName: draft.containerName,
                mode: "existingStoppedContainer"
            };
    }
}

function normalizeManagedContainer(
    draft: Extract<ConfigContainerDraft, { mode: "preset" | "dockerfile" | "existingImage" }>,
    defaultContainerName: string
) {
    return {
        containerName: draft.containerName ?? defaultContainerName,
        env: cloneNonEmptyRecord(draft.env),
        mounts: draft.mounts === undefined || draft.mounts.length === 0 ? undefined : draft.mounts.map((mount) => ({ ...mount })),
        network: draft.network,
        user: draft.user
    };
}

function toMcpAuthDraft(auth: ControlMcpAuthConfig): ConfigMcpAuthDraft {
    if (auth.mode !== "oauth2") return { mode: auth.mode };
    return {
        mode: "oauth2",
        oauth2: {
            ...auth.oauth2,
            requiredScopes: [...auth.oauth2.requiredScopes]
        }
    };
}

function cloneMcpAuth(auth: ControlMcpAuthConfig): ControlMcpAuthConfig {
    if (auth.mode !== "oauth2") return { mode: auth.mode };
    return {
        mode: "oauth2",
        oauth2: {
            ...auth.oauth2,
            requiredScopes: [...auth.oauth2.requiredScopes]
        }
    };
}

function cloneInstance(instance: ControlInstanceConfig): ControlInstanceConfig {
    const common = {
        approvalPolicy: cloneApprovalPolicy(instance.approvalPolicy),
        enabled: instance.enabled,
        env: cloneOptionalRecord(instance.env),
        logs: cloneOptionalRecord(instance.logs),
        mcp: {
            ...instance.mcp,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        name: instance.name,
        security: { ...instance.security },
        tools: cloneTools(instance.tools),
        workspace: instance.workspace
    };
    switch (instance.provider) {
        case "local":
            return { ...common, provider: "local" };
        case "reverse":
            return { ...common, provider: "reverse" };
        case "ssh":
            return { ...common, provider: "ssh", ssh: { ...instance.ssh } };
        case "docker":
            return {
                ...common,
                container: cloneContainer(instance.container),
                dockerBinary: instance.dockerBinary,
                provider: "docker"
            };
        case "podman":
            return {
                ...common,
                container: cloneContainer(instance.container),
                podmanBinary: instance.podmanBinary,
                provider: "podman"
            };
    }
}

function cloneContainer<T extends InstanceContainerConfig>(container: T): T {
    switch (container.mode) {
        case "preset":
        case "existingImage":
            return {
                ...container,
                env: cloneOptionalRecord(container.env),
                mounts: container.mounts?.map((mount) => ({ ...mount }))
            } as T;
        case "dockerfile":
            return {
                ...container,
                build: { ...container.build },
                env: cloneOptionalRecord(container.env),
                mounts: container.mounts?.map((mount) => ({ ...mount }))
            } as T;
        case "compose":
            return { ...container, compose: { ...container.compose } } as T;
        case "existingStoppedContainer":
            return { ...container } as T;
    }
}

function cloneApprovalPolicy(policy: ApprovalPolicy | undefined): ApprovalPolicy | undefined {
    return policy === undefined
        ? undefined
        : {
              mode: policy.mode,
              rules: policy.rules?.map((rule) => ({ ...rule }))
          };
}

function cloneTools(tools: ControlInstanceToolsConfig | undefined): ControlInstanceToolsConfig | undefined {
    return tools === undefined
        ? undefined
        : {
              scheduler:
                  tools.scheduler === undefined
                      ? undefined
                      : {
                            ...tools.scheduler,
                            byTool:
                                tools.scheduler.byTool === undefined
                                    ? undefined
                                    : Object.fromEntries(
                                          Object.entries(tools.scheduler.byTool).map(([name, limits]) => [name, { ...limits }])
                                      )
                        }
          };
}

function cloneOptionalRecord<T>(record: T | undefined): T | undefined {
    return record === undefined ? undefined : ({ ...record } as T);
}

function cloneNonEmptyRecord(record: Record<string, string> | undefined): Record<string, string> | undefined {
    return record === undefined || Object.keys(record).length === 0 ? undefined : { ...record };
}

function deduplicate<T>(values: readonly T[]): T[] {
    return [...new Set(values)];
}

function applyNullable<T>(value: T | null | undefined, fallback: T | undefined): T | undefined {
    return value === undefined ? fallback : value === null ? undefined : value;
}

function assertAbsent(value: unknown, path: readonly string[], provider: string): void {
    if (value !== undefined) {
        throw configInputError(
            "normalize",
            path,
            "config.instance.providerField",
            `is not supported for provider ${provider}`
        );
    }
}

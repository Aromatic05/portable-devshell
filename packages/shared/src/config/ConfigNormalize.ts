import type { ApprovalPolicy } from "../dto/tool/DtoToolApproval.js";
import type { InstanceContainerConfig } from "../dto/instance/DtoInstanceCreate.js";
import { configInputError } from "./ConfigIssue.js";
import type {
    ConfigContainerDraft,
    ConfigDraft,
    ConfigGlobalDraft,
    ConfigInstanceDraft,
    ConfigInstanceMcpDraft,
    ConfigInstancePatch,
    ConfigMcpPatch,
    ConfigWebOAuth2Draft,
    ConfigWebPatch,
    ConfigNormalizeContext,
    ConfigView,
    ConfigWebView,
    ControlConfig,
    ControlGlobalConfig,
    ControlInstanceConfig,
    ControlInstanceToolsConfig,
    ControlMcpAuthConfig,
    ControlWebAuthConfig,
    ControlWebAuthMode
} from "./ConfigModel.js";
import { defaultConfigNormalizeContext, MASKED_CONFIG_TOKEN } from "./ConfigModel.js";

const legacyDefaultMcpToolGroups = ["file", "bash", "artifact", "tmux", "todo"] as const;

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
    const mcpListenHost = draft.mcp?.listenHost ?? "127.0.0.1";
    const mcpListenPort = draft.mcp?.listenPort ?? 17890;
    const webListenHost = draft.web?.listenHost ?? mcpListenHost;
    const webListenPort = draft.web?.listenPort ?? mcpListenPort;
    return {
        control: {
            logLevel: draft.control?.logLevel ?? "info"
        },
        mcp: {
            enabled: draft.mcp?.enabled ?? false,
            listenHost: mcpListenHost,
            listenPort: mcpListenPort,
            publicBaseUrl: normalizePublicBaseUrl(draft.mcp?.publicBaseUrl, mcpListenHost, mcpListenPort)
        },
        web: {
            auth: normalizeWebAuth(draft.web),
            enabled: draft.web?.enabled ?? false,
            listenHost: webListenHost,
            listenPort: webListenPort,
            publicBaseUrl: normalizePublicBaseUrl(draft.web?.publicBaseUrl, webListenHost, webListenPort)
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
            auth: normalizeInstanceMcpAuth(draft.mcp),
            enabled: draft.mcp?.enabled ?? context.defaultMcpEnabled,
            path: expectedMcpPath,
            tools: {
                capabilities: deduplicate(draft.mcp?.tools?.capabilities ?? context.defaultMcpCapabilities),
                groups: normalizeMcpGroups(draft.mcp?.tools?.groups, context.defaultMcpGroups)
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
                      ...toInstanceMcpAuthDraft(
                          patch.mcp.auth === undefined
                              ? normalizeInstanceMcpAuth(base.mcp)
                              : normalizeInstanceMcpAuth({
                                    auth: patch.mcp.auth,
                                    oauth2: patch.mcp.oauth2,
                                    token: patch.mcp.token
                                })
                      ),
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
        enabled: patch.enabled ?? current.enabled,
        listenHost: patch.listenHost ?? current.listenHost,
        listenPort: patch.listenPort ?? current.listenPort,
        publicBaseUrl: patch.publicBaseUrl === undefined ? current.publicBaseUrl : patch.publicBaseUrl
    };
}

export function applyConfigWebPatch(
    current: ControlGlobalConfig["web"],
    patch: ConfigWebPatch
): ConfigGlobalDraft["web"] {
    const resolvedToken =
        patch.token === MASKED_CONFIG_TOKEN
            ? current.auth.mode === "token"
                ? current.auth.token
                : undefined
            : patch.token;
    const authDraft =
        patch.auth === undefined
            ? toWebAuthDraft(current.auth)
            : toWebAuthDraft(
                  normalizeWebAuth({
                      auth: patch.auth,
                      oauth2: patch.oauth2,
                      token: resolvedToken
                  })
              );
    return {
        ...authDraft,
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
            ...toConfigInstanceDraft(instance),
            security: {
                effectiveMode: instance.security.mode,
                mode: instance.security.mode
            }
        })) as unknown as ConfigView["instances"],
        mcp: { ...config.mcp },
        web: toWebView(config.web)
    };
}

function toWebView(web: ControlGlobalConfig["web"]): ConfigWebView {
    const auth = web.auth;
    return {
        auth: auth.mode,
        enabled: web.enabled,
        listenHost: web.listenHost,
        listenPort: web.listenPort,
        oauth2:
            auth.mode === "oauth2"
                ? { ...auth.oauth2, requiredScopes: [...auth.oauth2.requiredScopes] }
                : undefined,
        publicBaseUrl: web.publicBaseUrl,
        token: auth.mode === "token" ? MASKED_CONFIG_TOKEN : undefined
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
            ...toInstanceMcpAuthDraft(instance.mcp.auth),
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

function normalizeInstanceMcpAuth(
    draft: Pick<ConfigInstanceMcpDraft, "auth" | "oauth2" | "token"> | undefined
): ControlMcpAuthConfig {
    if (draft?.auth === undefined || draft.auth === "none") return { mode: "none" };
    if (draft.auth === "token") return { mode: "token", token: draft.token! };
    return {
        mode: "oauth2",
        oauth2: {
            documentationUrl: draft.oauth2!.documentationUrl,
            requiredScopes: deduplicate(draft.oauth2!.requiredScopes ?? []),
            resourceName: draft.oauth2!.resourceName
        }
    };
}

function toInstanceMcpAuthDraft(
    auth: ControlMcpAuthConfig
): Partial<Pick<ConfigInstanceMcpDraft, "auth" | "oauth2" | "token">> {
    if (auth.mode === "none") return { auth: "none" };
    if (auth.mode === "token") return { auth: "token", token: auth.token };
    return {
        auth: "oauth2",
        oauth2: {
            ...auth.oauth2,
            requiredScopes: [...auth.oauth2.requiredScopes]
        }
    };
}

function normalizeWebAuth(
    draft: { auth?: ControlWebAuthMode; oauth2?: ConfigWebOAuth2Draft; token?: string } | undefined
): ControlWebAuthConfig {
    if (draft?.auth === undefined || draft.auth === "none") return { mode: "none" };
    if (draft.auth === "token") return { mode: "token", token: draft.token! };
    return {
        mode: "oauth2",
        oauth2: {
            documentationUrl: draft.oauth2!.documentationUrl,
            requiredScopes: deduplicate(draft.oauth2!.requiredScopes ?? []),
            resourceName: draft.oauth2!.resourceName
        }
    };
}

function toWebAuthDraft(auth: ControlWebAuthConfig): {
    auth: ControlWebAuthMode;
    oauth2?: ConfigWebOAuth2Draft;
    token?: string;
} {
    if (auth.mode === "none") return { auth: "none" };
    if (auth.mode === "token") return { auth: "token", token: auth.token };
    return {
        auth: "oauth2",
        oauth2: {
            ...auth.oauth2,
            requiredScopes: [...auth.oauth2.requiredScopes]
        }
    };
}

export function normalizePublicBaseUrl(
    value: string | null | undefined,
    listenHost: string,
    listenPort: number
): string {
    const source = value === null ? undefined : value;
    if (source === undefined) return `http://${formatUrlHost(listenHost)}:${listenPort}`;
    if (/^https?:\/\//iu.test(source)) return source;
    return `http://${formatUrlHost(source)}:${listenPort}`;
}

function formatUrlHost(value: string): string {
    return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value;
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

function normalizeMcpGroups(configured: readonly string[] | undefined, defaults: readonly string[]): string[] {
    const normalized = deduplicate(configured ?? defaults);
    if (
        configured !== undefined &&
        normalized.length === legacyDefaultMcpToolGroups.length &&
        normalized.every((value, index) => value === legacyDefaultMcpToolGroups[index])
    ) {
        return [...normalized, "context"];
    }
    return normalized;
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

import type { McpHost, McpInstanceGateway, McpSshInstanceCreateInput } from "@portable-devshell/mcp";
import {
    ConfigInputError,
    configInputError,
    createError,
    defaultConfigNormalizeContext,
    errorCodes,
    formatConfigPath,
    normalizeConfigInstanceDraft,
    parseConfigInstanceDraft,
    type ConfigInstanceDraft,
    type ControlConfig,
    type ControlInstanceConfig,
    type InstanceContainerPresetSchema,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue
} from "@portable-devshell/shared";

import { InstanceFactory } from "../InstanceFactory.js";
import type { InstanceRegistry } from "../registry/InstanceRegistry.js";
import { McpEndpointFactory } from "../../../composition/McpEndpointFactory.js";
import { ControlConfigStore } from "../../config/ControlConfigStore.js";
import { ControlConfigValidator } from "../../config/ControlConfigValidator.js";
import { listInstanceCreateProviders } from "./InstanceCreateProviderCatalog.js";

const containerPresets = defaultConfigNormalizeContext.containerPresets satisfies readonly InstanceContainerPresetSchema[];

const instanceCreateSchema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"],
        presets: containerPresets
    },
    defaultMcpCapabilities: defaultConfigNormalizeContext.defaultMcpCapabilities,
    defaultMcpGroups: defaultConfigNormalizeContext.defaultMcpGroups,
    defaultEnabled: defaultConfigNormalizeContext.defaultEnabled,
    defaultMcpEnabled: defaultConfigNormalizeContext.defaultMcpEnabled,
    defaultProvider: "local",
    defaultSecurityMode: defaultConfigNormalizeContext.defaultSecurityMode,
    providers: ["local", "ssh", "docker", "podman", "reverse"]
};

export interface InstanceCreateCoordinatorOptions {
    configStore: ControlConfigStore;
    getConfig: () => ControlConfig;
    getMcpHost: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    platform?: NodeJS.Platform;
    mcpEndpointConfigMapper?: McpEndpointFactory;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

export class InstanceCreateCoordinator {
    readonly #configStore: ControlConfigStore;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceFactory;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointFactory;
    readonly #platform: NodeJS.Platform;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;

    constructor(options: InstanceCreateCoordinatorOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost;
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointFactory();
        this.#platform = options.platform ?? process.platform;
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getSchema(): InstanceCreateSchema {
        return {
            ...instanceCreateSchema,
            providers: listInstanceCreateProviders(this.#platform)
        };
    }

    validateDraft(params: JsonValue | undefined): InstanceCreateSummary {
        const normalized = this.#normalizeDraft(params);
        this.#validateMergedConfig(normalized);
        return toSummary(normalized);
    }

    async createInstance(params: JsonValue | undefined): Promise<InstanceCreateResult> {
        return await this.#createNormalized(this.#normalizeDraft(params));
    }

    async createSshInstanceFromMcp(
        sourceInstanceName: string,
        input: McpSshInstanceCreateInput
    ): Promise<InstanceCreateResult> {
        const source = this.#getConfig().instances.find((instance) => instance.name === sourceInstanceName);
        if (source === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: sourceInstanceName },
                message: `Source instance ${sourceInstanceName} was not found.`,
                retryable: false
            });
        }

        const draft: ConfigInstanceDraft = {
            approvalPolicy:
                source.approvalPolicy === undefined
                    ? undefined
                    : {
                          mode: source.approvalPolicy.mode,
                          rules: source.approvalPolicy.rules?.map((rule) => ({ ...rule }))
                      },
            enabled: true,
            mcp: {
                enabled: true,
                tools: {
                    capabilities: source.mcp.tools.capabilities.filter((capability) => capability !== "manage"),
                    groups: source.mcp.tools.groups.filter((group) => group !== "instance")
                }
            },
            name: input.name,
            provider: "ssh",
            security: { ...source.security },
            ssh: {
                command: this.#readConfigInput(() => buildMcpSshCommand(input))
            },
            workspace: input.workspace
        };

        return await this.#createNormalized(
            this.#readConfigInput(() => normalizeConfigInstanceDraft(draft))
        );
    }

    async #createNormalized(normalized: ControlInstanceConfig): Promise<InstanceCreateResult> {
        const nextConfig = this.#validateMergedConfig(normalized);
        await this.#configStore.write(nextConfig, this.#homeDirectory);
        this.#setConfig(nextConfig);

        if (!normalized.enabled) {
            return {
                enabled: false,
                mcpPath: normalized.mcp.enabled ? normalized.mcp.path : undefined,
                name: normalized.name
            };
        }

        const descriptor = this.#instanceConfigMapper.map(normalized);
        this.#instanceRegistry.add(descriptor);
        if (nextConfig.mcp.enabled && normalized.mcp.enabled) {
            this.#getMcpHost()?.registerInstance(
                this.#mcpEndpointConfigMapper.map(descriptor, this.#getMcpInstanceGateway())
            );
        }

        return {
            enabled: true,
            mcpPath: normalized.mcp.enabled ? normalized.mcp.path : undefined,
            name: normalized.name,
            snapshot: descriptor.worker.snapshot()
        };
    }

    #validateMergedConfig(instance: ControlInstanceConfig): ControlConfig {
        const currentConfig = this.#getConfig();
        if (currentConfig.instances.some((entry) => entry.name === instance.name)) {
            throw createError({
                code: errorCodes.instanceAlreadyExists,
                details: { instance: instance.name },
                message: `Instance ${instance.name} already exists.`,
                retryable: false
            });
        }

        try {
            return this.#validator.validate({
                ...currentConfig,
                instances: [...currentConfig.instances, instance]
            });
        } catch (error) {
            throw toConfigInvalidError(error);
        }
    }

    #normalizeDraft(params: JsonValue | undefined): ControlInstanceConfig {
        return this.#readConfigInput(() => {
            const draft = parseConfigInstanceDraft(params);
            if (!listInstanceCreateProviders(this.#platform).includes(draft.provider)) {
                throw configInputError(
                    "semantic",
                    ["provider"],
                    "config.instance.providerUnsupported",
                    `is not supported on ${this.#platform}`
                );
            }
            return normalizeConfigInstanceDraft(draft);
        });
    }

    #readConfigInput<T>(read: () => T): T {
        try {
            return read();
        } catch (error) {
            if (!(error instanceof ConfigInputError)) throw error;
            throw createError({
                code: errorCodes.controlConfigInvalid,
                cause: error,
                details: {
                    fieldPath: formatConfigPath(error.issue.path),
                    issueCode: error.issue.code,
                    phase: error.issue.phase
                },
                message: error.message,
                retryable: false
            });
        }
    }
}

function buildMcpSshCommand(input: McpSshInstanceCreateInput): string {
    assertSafeSshAtom(input.host, "host");
    if (input.user !== undefined) assertSafeSshAtom(input.user, "user");

    const args = ["ssh"];
    if (input.port !== undefined) args.push("-p", String(input.port));
    if (input.identityFile !== undefined) args.push("-i", input.identityFile);
    args.push(input.user === undefined ? input.host : `${input.user}@${input.host}`);
    return args.map(quoteCommandArgument).join(" ");
}

function assertSafeSshAtom(value: string, fieldName: string): void {
    const hasUnsafeCharacter = [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
    });
    if (value.startsWith("-") || hasUnsafeCharacter) {
        throw configInputError(
            "semantic",
            [fieldName],
            "config.ssh.unsafeAtom",
            "must not contain whitespace, control characters, or begin with '-'"
        );
    }
}

function quoteCommandArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function toConfigInvalidError(error: unknown): Error {
    if (isStructuredError(error)) {
        return createError({
            code: errorCodes.controlConfigInvalid,
            cause: error,
            details: error.details,
            message: error.message,
            retryable: false
        });
    }
    return createError({
        code: errorCodes.controlConfigInvalid,
        cause: error,
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    });
}

function isStructuredError(error: unknown): error is { details?: JsonValue; message: string } {
    return (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
    );
}

function toSummary(instance: ControlInstanceConfig): InstanceCreateSummary {
    return {
        ...(instance.container === undefined ? {} : { container: instance.container }),
        ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
        ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
        enabled: instance.enabled,
        mcp: {
            enabled: instance.mcp.enabled,
            path: instance.mcp.path,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        name: instance.name,
        provider: instance.provider,
        security: {
            mode: instance.security.mode
        },
        ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
        workspace: instance.workspace
    };
}

import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";
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
import { ControlConfigValidator } from "../../config/ControlConfigValidator.js";
import { ControlConfigMutationLock, type ControlConfigMutationRunner } from "../../config/ControlConfigMutationLock.js";
import { listInstanceCreateProviders } from "./InstanceCreateProviderCatalog.js";

const containerPresets = defaultConfigNormalizeContext.containerPresets satisfies readonly InstanceContainerPresetSchema[];

const instanceCreateSchema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"],
        presets: containerPresets
    },
    defaultMcpContextMode: "explicit",
    defaultModelExtensions: defaultConfigNormalizeContext.defaultModelExtensions,
    defaultEnabled: defaultConfigNormalizeContext.defaultEnabled,
    defaultMcpEnabled: defaultConfigNormalizeContext.defaultMcpEnabled,
    defaultProvider: "local",
    defaultSecurityMode: defaultConfigNormalizeContext.defaultSecurityMode,
    providers: ["local", "ssh", "docker", "podman", "reverse"]
};

interface ControlConfigWriter {
    write(config: ControlConfig, homeDirectory?: string): Promise<void>;
}

export interface InstanceCreateCoordinatorOptions {
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    getMcpHost: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    platform?: NodeJS.Platform;
    mcpEndpointConfigMapper?: McpEndpointFactory;
    mutationRunner?: ControlConfigMutationRunner;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

export class InstanceCreateCoordinator {
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceFactory;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointFactory;
    readonly #mutationRunner: ControlConfigMutationRunner;
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
        this.#mutationRunner = options.mutationRunner ?? new ControlConfigMutationLock();
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
        const normalized = this.#normalizeDraft(params);
        return await this.#mutationRunner.runExclusive(async () => await this.#createNormalized(normalized));
    }
    async #createNormalized(normalized: ControlInstanceConfig): Promise<InstanceCreateResult> {
        const previousConfig = this.#getConfig();
        const nextConfig = this.#validateMergedConfig(normalized);
        const descriptor = normalized.enabled ? this.#instanceConfigMapper.map(normalized) : undefined;
        let persisted = false;

        try {
            await this.#configStore.write(nextConfig, this.#homeDirectory);
            this.#setConfig(nextConfig);
            persisted = true;

            if (!normalized.enabled || descriptor === undefined) {
                return {
                    enabled: false,
                    mcpPath: normalized.mcp.enabled ? normalized.mcp.path : undefined,
                    name: normalized.name
                };
            }

            this.#instanceRegistry.add(descriptor);
            if (nextConfig.mcp.enabled && normalized.mcp.enabled) {
                this.#getMcpHost()?.registerInstance(
                    this.#mcpEndpointConfigMapper.map(descriptor, this.#getMcpInstanceGateway(), normalized.mcp.auth)
                );
            }

            return {
                enabled: true,
                mcpPath: normalized.mcp.enabled ? normalized.mcp.path : undefined,
                name: normalized.name,
                snapshot: descriptor.worker.snapshot()
            };
        } catch (error) {
            const failures: unknown[] = [error];
            this.#getMcpHost()?.unregisterInstance(normalized.name);
            this.#instanceRegistry.delete(normalized.name);
            if (descriptor !== undefined) {
                const close = (descriptor.worker as { close?: () => Promise<void> }).close;
                if (close !== undefined) await close.call(descriptor.worker).catch((closeError) => failures.push(closeError));
            }
            if (persisted) {
                try {
                    await this.#configStore.write(previousConfig, this.#homeDirectory);
                    this.#setConfig(previousConfig);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(failures, `Instance ${normalized.name} creation failed and rollback was incomplete.`);
        }
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
        ...(instance.approvalPolicy === undefined ? {} : { approvalPolicy: structuredClone(instance.approvalPolicy) }),
        ...(instance.container === undefined ? {} : { container: redactContainerSecrets(instance.container) }),
        ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
        ...(instance.env === undefined ? {} : { env: redactSecretRecord(instance.env) }),
        extensions: { model: [...instance.extensions.model] },
        ...(instance.logs === undefined ? {} : { logs: { ...instance.logs } }),
        ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
        enabled: instance.enabled,
        mcp: {
            auth: {
                mode: instance.mcp.auth.mode,
                ...(instance.mcp.auth.mode === "oauth2"
                    ? { oauth2: structuredClone(instance.mcp.auth.oauth2) }
                    : {})
            },
            contextMode: instance.mcp.contextMode,
            enabled: instance.mcp.enabled,
            path: instance.mcp.path
        },
        name: instance.name,
        provider: instance.provider,
        security: {
            mode: instance.security.mode
        },
        ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
        ...(instance.tools === undefined ? {} : { tools: structuredClone(instance.tools) })
    };
}

function redactContainerSecrets(container: ControlInstanceConfig["container"]): NonNullable<ControlInstanceConfig["container"]> {
    const copy = structuredClone(container!);
    if ("env" in copy && copy.env !== undefined) copy.env = redactSecretRecord(copy.env);
    return copy;
}

function redactSecretRecord(record: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.keys(record).map((key) => [key, "********"]));
}

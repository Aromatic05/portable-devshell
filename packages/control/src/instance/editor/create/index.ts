import {
    createRemoteError,
    controlErrorCodes,
    type ControlConfig,
    type ControlInstanceConfig,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue,
} from "@portable-devshell/shared";

import {
    createInstance,
    discoverSshConfigHosts,
    normalizeInstanceCreateDraft,
    resolveInstanceCreateSchema,
    summarizeInstanceCreate,
    type InstanceRegistry,
} from "@portable-devshell/core";
import type { InstanceMcpRuntimePort } from "../../Mcp.js";
import { InstanceChangeHub } from "../../Change.js";
import { ControlConfigValidator } from "../../../config/engine/Validator.js";
import {
    ControlConfigMutationLock,
    type ControlConfigMutationRunner,
} from "../../../config/engine/Lock.js";
interface ControlConfigWriter {
    write(config: ControlConfig, homeDirectory?: string): Promise<void>;
}

export interface InstanceCreateCoordinatorOptions {
    assertCleanupSettled?: (instance: string) => Promise<void>;
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    homeDirectory?: string;
    instanceChanges: InstanceChangeHub;
    instanceRegistry: InstanceRegistry;
    platform?: NodeJS.Platform;
    mcp?: InstanceMcpRuntimePort;
    mutationRunner?: ControlConfigMutationRunner;
    setConfig: (config: ControlConfig) => void;
    sshHosts?: () => readonly string[];
    validator?: ControlConfigValidator;
}

export class InstanceCreateCoordinator {
    readonly #assertCleanupSettled: (instance: string) => Promise<void>;
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #homeDirectory?: string;
    readonly #instanceChanges: InstanceChangeHub;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcp?: InstanceMcpRuntimePort;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #platform: NodeJS.Platform;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #sshHosts: () => readonly string[];
    readonly #validator: ControlConfigValidator;

    constructor(options: InstanceCreateCoordinatorOptions) {
        this.#assertCleanupSettled =
            options.assertCleanupSettled ?? (async () => {});
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#homeDirectory = options.homeDirectory;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcp = options.mcp;
        this.#mutationRunner =
            options.mutationRunner ?? new ControlConfigMutationLock();
        this.#platform = options.platform ?? process.platform;
        this.#setConfig = options.setConfig;
        this.#sshHosts = options.sshHosts ?? discoverSshConfigHosts;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getSchema(): InstanceCreateSchema {
        const hasLocal = this.#getConfig().instances.some(
            (instance) => instance.provider === "local",
        );
        return resolveInstanceCreateSchema({
            hasLocal,
            platform: this.#platform,
            sshHosts: this.#sshHosts(),
        });
    }

    validateDraft(params: JsonValue | undefined): InstanceCreateSummary {
        const normalized = normalizeInstanceCreateDraft(
            params,
            this.#platform,
        );
        this.#validateMergedConfig(normalized);
        return summarizeInstanceCreate(normalized);
    }

    async createInstance(
        params: JsonValue | undefined,
    ): Promise<InstanceCreateResult> {
        const normalized = normalizeInstanceCreateDraft(
            params,
            this.#platform,
        );
        return await this.#mutationRunner.runExclusive(
            async () => await this.#createNormalized(normalized),
        );
    }
    async #createNormalized(
        normalized: ControlInstanceConfig,
    ): Promise<InstanceCreateResult> {
        await this.#assertCleanupSettled(normalized.name);
        const previousConfig = this.#getConfig();
        const nextConfig = this.#validateMergedConfig(normalized);
        const descriptor = normalized.enabled
            ? createInstance(normalized)
            : undefined;
        let persisted = false;

        try {
            await this.#configStore.write(nextConfig, this.#homeDirectory);
            this.#setConfig(nextConfig);
            persisted = true;

            if (!normalized.enabled || descriptor === undefined) {
                return {
                    enabled: false,
                    mcpPath: normalized.mcp.enabled
                        ? normalized.mcp.path
                        : undefined,
                    name: normalized.name,
                };
            }

            this.#instanceRegistry.add(descriptor);
            this.#instanceChanges.publish("registry");
            if (nextConfig.mcp.enabled && normalized.mcp.enabled) {
                this.#mcp?.registerInstance(
                    normalized.name,
                    normalized.mcp.auth,
                );
            }

            return {
                enabled: true,
                mcpPath: normalized.mcp.enabled
                    ? normalized.mcp.path
                    : undefined,
                name: normalized.name,
            };
        } catch (error) {
            const failures: unknown[] = [error];
            this.#mcp?.unregisterInstance(normalized.name);
            await this.#instanceRegistry.remove(normalized.name);
            this.#instanceChanges.publish("registry");
            if (persisted) {
                try {
                    await this.#configStore.write(
                        previousConfig,
                        this.#homeDirectory,
                    );
                    this.#setConfig(previousConfig);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(
                failures,
                `Instance ${normalized.name} creation failed and rollback was incomplete.`,
            );
        }
    }

    #validateMergedConfig(instance: ControlInstanceConfig): ControlConfig {
        const currentConfig = this.#getConfig();
        if (
            currentConfig.instances.some(
                (entry) => entry.name === instance.name,
            )
        ) {
            throw createRemoteError({
                code: controlErrorCodes.instanceAlreadyExists,
                details: { instance: instance.name },
                message: `Instance ${instance.name} already exists.`,
                retryable: false,
            });
        }

        try {
            return this.#validator.validate({
                ...currentConfig,
                instances: [...currentConfig.instances, instance],
            });
        } catch (error) {
            throw toConfigInvalidError(error);
        }
    }


}

function toConfigInvalidError(error: unknown): Error {
    if (isStructuredError(error)) {
        return createRemoteError({
            code: controlErrorCodes.configInvalid,
            cause: error,
            details: error.details,
            message: error.message,
            retryable: false,
        });
    }
    return createRemoteError({
        code: controlErrorCodes.configInvalid,
        cause: error,
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
    });
}

function isStructuredError(
    error: unknown,
): error is { details?: JsonValue; message: string } {
    return (
        typeof error === "object" &&
        error !== null &&
        "message" in error &&
        typeof error.message === "string"
    );
}


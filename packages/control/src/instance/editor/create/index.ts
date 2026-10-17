import type { InstanceRegistry } from "../../Registry.js";
import { createRemoteError, controlErrorCodes, type ControlConfig, type ControlInstanceConfig, type InstanceCreateResult, type InstanceCreateSchema, type InstanceCreateSummary, type JsonValue, } from "@portable-devshell/shared";

import type { Instance } from "@portable-devshell/core";
import {
    discoverSshConfigHosts,
    normalizeInstanceCreateDraft,
    resolveInstanceCreateSchema,
    summarizeInstanceCreate,
} from "./Config.js";
import type { InstanceMcpRuntimePort } from "../../Mcp.js";
import { InstanceChangeHub } from "../../Change.js";
import type { ConfigEngine } from "../../../config/engine/index.js";
import { closeDescriptorResourcesBestEffort } from "../retirement/State.js";

export interface InstanceCreateCoordinatorOptions {
    assertCleanupSettled?: (instance: string, reconcile?: boolean) => Promise<void>;
    createRuntimeInstance(
        config: ControlConfig["instances"][number],
    ): Instance;
    engine: ConfigEngine;
    finalizeRuntimeInstance(
        descriptor: Instance,
    ): Promise<void>;
    instanceChanges: InstanceChangeHub;
    instanceRegistry: InstanceRegistry;
    platform?: NodeJS.Platform;
    mcp?: InstanceMcpRuntimePort;
    sshHosts?: () => readonly string[];
}

export class InstanceCreateCoordinator {
    readonly #assertCleanupSettled: (instance: string, reconcile?: boolean) => Promise<void>;
    readonly #createRuntimeInstance: InstanceCreateCoordinatorOptions["createRuntimeInstance"];
    readonly #engine: ConfigEngine;
    readonly #finalizeRuntimeInstance: InstanceCreateCoordinatorOptions["finalizeRuntimeInstance"];
    readonly #instanceChanges: InstanceChangeHub;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcp?: InstanceMcpRuntimePort;
    readonly #platform: NodeJS.Platform;
    readonly #sshHosts: () => readonly string[];

    constructor(options: InstanceCreateCoordinatorOptions) {
        this.#assertCleanupSettled =
            options.assertCleanupSettled ?? (async () => {});
        this.#createRuntimeInstance = options.createRuntimeInstance;
        this.#engine = options.engine;
        this.#finalizeRuntimeInstance = options.finalizeRuntimeInstance;
        this.#instanceChanges = options.instanceChanges;
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcp = options.mcp;
        this.#platform = options.platform ?? process.platform;
        this.#sshHosts = options.sshHosts ?? discoverSshConfigHosts;
    }

    getSchema(): InstanceCreateSchema {
        const hasLocal = this.#engine.current.instances.some(
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
        // Historical cleanup may need an unavailable remote Worker. Resolve
        // it before acquiring the global config mutation lock.
        await this.#assertCleanupSettled(normalized.name);
        return await this.#engine.runExclusive(
            async () => await this.#createNormalized(normalized),
        );
    }
    async #createNormalized(
        normalized: ControlInstanceConfig,
    ): Promise<InstanceCreateResult> {
        // Revalidate under the lock without retrying remote cleanup there.
        await this.#assertCleanupSettled(normalized.name, false);
        const previousConfig = this.#engine.current;
        const nextConfig = this.#validateMergedConfig(normalized);
        const descriptor = normalized.enabled
            ? this.#createRuntimeInstance(normalized)
            : undefined;
        let persisted = false;

        try {
            await this.#engine.persist(nextConfig);
            persisted = true;

            if (!normalized.enabled || descriptor === undefined) {
                this.#engine.publishCommittedChange(previousConfig, nextConfig);
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
            this.#engine.publishCommittedChange(previousConfig, nextConfig);

            return {
                enabled: true,
                mcpPath: normalized.mcp.enabled
                    ? normalized.mcp.path
                    : undefined,
                name: normalized.name,
            };
        } catch (error) {
            const failures: unknown[] = [error];
            try {
                this.#mcp?.unregisterInstance(normalized.name);
            } catch (cleanupError) {
                failures.push(cleanupError);
            }
            const current = this.#instanceRegistry.get(normalized.name);
            if (descriptor !== undefined) {
                if (current === descriptor) {
                    await this.#instanceRegistry
                        .remove(normalized.name, descriptor)
                        .catch((cleanupError) => failures.push(cleanupError));
                } else {
                    await descriptor
                        .retire()
                        .catch((cleanupError) => failures.push(cleanupError));
                }
                await closeDescriptorResourcesBestEffort(
                    descriptor,
                    this.#finalizeRuntimeInstance,
                ).catch((cleanupError) => failures.push(cleanupError));
            } else if (current !== undefined) {
                await this.#instanceRegistry
                    .remove(normalized.name, current)
                    .catch((cleanupError) => failures.push(cleanupError));
            }
            if (persisted) {
                await this.#engine
                    .persist(previousConfig)
                    .catch((rollbackError) => failures.push(rollbackError));
            }
            if (current === descriptor && descriptor !== undefined) {
                this.#instanceChanges.publish("registry");
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(
                failures,
                `Instance ${normalized.name} creation failed and rollback was incomplete.`,
            );
        }
    }

    #validateMergedConfig(instance: ControlInstanceConfig): ControlConfig {
        const currentConfig = this.#engine.current;
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
            return this.#engine.validateConfig({
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

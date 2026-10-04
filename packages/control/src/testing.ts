export * from "./server/Daemon.js";
export * from "./config/engine/Http.js";
export * from "./artifact/Service.js";
export * from "./artifact/route/Http.js";
export * from "./artifact/host/Bridge.js";
export * from "./artifact/host/Model.js";
export {
    ConfigEditorCoordinator as ProductionConfigEditorCoordinator,
    type ConfigEditorCoordinatorOptions,
    type ConfigRuntimeChangeSet,
} from "./config/editor/index.js";
export {
    ConfigEngine,
    type ConfigEngineOptions,
} from "./config/engine/index.js";
export {
    InstanceEditorCoordinator,
    type InstanceEditorCoordinatorOptions,
} from "./instance/editor/index.js";
export { createDefaultControlConfig } from "@portable-devshell/shared";
export * from "./config/store/index.js";
export * from "./config/engine/Lock.js";
export * from "./config/store/TomlCodec.js";
export * from "./config/store/document/Global.js";
export * from "./config/store/document/Instance.js";
export * from "./config/engine/Validator.js";
export * from "./config/domain/Registry.js";
export * from "./config/domain/index.js";
export * from "./config/domain/Store.js";
export {
    InstanceFactory,
    InstanceRegistry,
    InstanceRegistryFactory,
} from "@portable-devshell/core";
export * from "./instance/editor/create/index.js";
export * from "./server/mcp/Endpoint.js";
export * from "./server/mcp/Runtime.js";
export {
    ReverseCredentialService,
    ReverseCredentialStore,
} from "@portable-devshell/core";
export * from "./server/Route.js";
export {
    ControlRuntime as ProductionControlRuntime,
    type ControlRuntimeOptions,
} from "./server/runtime/Runtime.js";
export * from "./server/transport/endpoint/Socket.js";

export * from "./context/Registry/index.js";
export * from "./context/Service/Scope.js";
export * from "./context/Service/Cleanup.js";
export * from "./context/Service/index.js";
export * from "./context/Module.js";

import type {
    ApprovalApi,
    InstanceRegistry,
    TaskApi,
} from "@portable-devshell/core";
import { InstanceRegistry as CoreInstanceRegistry } from "@portable-devshell/core";
import type { JsonValue, TodoReadResult } from "@portable-devshell/shared";
import { ConfigEditorCoordinator as ProductionConfigEditorCoordinator } from "./config/editor/index.js";
import {
    ConfigEngine,
    type ConfigEngineOptions,
} from "./config/engine/index.js";
import type { ConfigBatchInstancePort } from "./config/editor/Batch.js";
import {
    InstanceEditorCoordinator,
    type InstanceEditorCoordinatorOptions,
} from "./instance/editor/index.js";

export function createTestApprovalApi(
    overrides: Partial<ApprovalApi> = {},
): ApprovalApi {
    return {
        async cancel() {
            throw new Error("Approval cancellation is not configured.");
        },
        close() {},
        async decideApproval() {
            throw new Error("Approval decisions are not configured.");
        },
        async evaluate() {
            return { decision: "allow" };
        },
        async getApproval() {
            throw new Error("Approval lookup is not configured.");
        },
        async listApprovals() {
            return [];
        },
        async listPendingApprovals() {
            return [];
        },
        async retire() {},
        setPolicy() {},
        ...overrides,
    };
}

export function createTestTaskApi(overrides: Partial<TaskApi> = {}): TaskApi {
    const empty: TodoReadResult = {
        items: [],
        revision: 0,
        summary: { completed: 0, total: 0 },
    };
    return {
        goal: {
            async continuation() {
                return {};
            },
            async list() {
                return [];
            },
            async manage() {
                return undefined;
            },
            async read() {
                return undefined;
            },
            async recordReentry() {},
            async stopAll() {
                return [];
            },
            async touch() {},
        },
        todo: {
            async cancelAll() {},
            async control() {
                return empty;
            },
            async delete() {},
            async read() {
                return empty;
            },
            summaries() {
                return [];
            },
            async write() {
                return empty;
            },
        },
        wait: {
            close() {},
            async detach(input) {
                const now = new Date(0).toISOString();
                return {
                    ...input,
                    createdAt: now,
                    status: "detached" as const,
                    updatedAt: now,
                    waitId: "wait-test",
                };
            },
            async list() {
                return [];
            },
            resume() {},
        },
        ...overrides,
    };
}

export type TestConfigEditorCoordinatorOptions = Partial<ConfigEngineOptions> &
    Partial<
        Omit<InstanceEditorCoordinatorOptions, "engine" | "instanceRegistry">
    > & {
        engine?: ConfigEngine;
        instanceRegistry?: InstanceRegistry;
        instances?: ConfigBatchInstancePort;
    };

/** Test-only facade preserving old combined Config/Instance test ergonomics. */
export class ConfigEditorCoordinator {
    readonly #config: ProductionConfigEditorCoordinator;
    readonly #instance: InstanceEditorCoordinator;

    constructor(options: TestConfigEditorCoordinatorOptions) {
        const engine =
            options.engine ?? new ConfigEngine(requireEngineOptions(options));
        this.#instance = new InstanceEditorCoordinator({
            engine,
            instanceRegistry:
                options.instanceRegistry ?? new CoreInstanceRegistry([]),
            ...(options.cleanupDebtFile === undefined
                ? {}
                : { cleanupDebtFile: options.cleanupDebtFile }),
            ...(options.detachContextInstance === undefined
                ? {}
                : { detachContextInstance: options.detachContextInstance }),
            ...(options.instanceConfigMapper === undefined
                ? {}
                : { instanceConfigMapper: options.instanceConfigMapper }),
            ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
            ...(options.reconcileContextInstanceCleanup === undefined
                ? {}
                : {
                      reconcileContextInstanceCleanup:
                          options.reconcileContextInstanceCleanup,
                  }),
        });
        this.#config = new ProductionConfigEditorCoordinator({
            ...requireEngineOptions(options, engine),
            engine,
            instances: options.instances ?? this.#instance,
        });
    }

    getConfigView(): JsonValue {
        return this.#config.getConfigView();
    }
    validateConfigDraft(params?: JsonValue): JsonValue {
        return this.#config.validateConfigDraft(params);
    }
    async updateCorePaths(
        patch: Readonly<Record<string, JsonValue>>,
    ): Promise<void> {
        await this.#config.updateCorePaths(patch);
    }
    async updateConfig(params?: JsonValue): Promise<JsonValue> {
        return await this.#config.updateConfig(params);
    }
    async updateMcpConfig(params?: JsonValue): Promise<JsonValue> {
        return await this.#config.updateMcpConfig(params);
    }
    async updateWebConfig(params?: JsonValue): Promise<JsonValue> {
        return await this.#config.updateWebConfig(params);
    }
    async updateInstanceConfig(params?: JsonValue): Promise<JsonValue> {
        return await this.#instance.updateInstanceConfig(params);
    }
    async deleteInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#instance.deleteInstance(params);
    }
    async enableInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#instance.enableInstance(params);
    }
    async disableInstance(params?: JsonValue): Promise<JsonValue> {
        return await this.#instance.disableInstance(params);
    }
    async assertInstanceCleanupSettled(instance: string): Promise<void> {
        await this.#instance.assertInstanceCleanupSettled(instance);
    }
    async reconcileCleanupDebt(instance?: string): Promise<void> {
        await this.#instance.reconcileCleanupDebt(instance);
    }

    registerInstanceDeleteRetirement(
        listener: Parameters<
            InstanceEditorCoordinator["registerInstanceDeleteRetirement"]
        >[0],
    ): () => void {
        return this.#instance.registerInstanceDeleteRetirement(listener);
    }
    registerInstanceDisableRetirement(
        listener: Parameters<
            InstanceEditorCoordinator["registerInstanceDisableRetirement"]
        >[0],
    ): () => void {
        return this.#instance.registerInstanceDisableRetirement(listener);
    }
    registerInstanceGenerationRetirement(
        listener: Parameters<
            InstanceEditorCoordinator["registerInstanceGenerationRetirement"]
        >[0],
    ): () => void {
        return this.#instance.registerInstanceGenerationRetirement(listener);
    }
    registerInstanceDisabled(
        listener: Parameters<
            InstanceEditorCoordinator["registerInstanceDisabled"]
        >[0],
    ): () => void {
        return this.#instance.registerInstanceDisabled(listener);
    }
    registerInstanceDeleted(
        listener: Parameters<
            InstanceEditorCoordinator["registerInstanceDeleted"]
        >[0],
    ): () => void {
        return this.#instance.registerInstanceDeleted(listener);
    }
}

function requireEngineOptions(
    options: TestConfigEditorCoordinatorOptions,
    fallback?: ConfigEngine,
): ConfigEngineOptions {
    if (
        options.configStore !== undefined &&
        options.getConfig !== undefined &&
        options.setConfig !== undefined
    ) {
        return {
            configStore: options.configStore,
            getConfig: options.getConfig,
            setConfig: options.setConfig,
            ...(options.changeHub === undefined
                ? {}
                : { changeHub: options.changeHub }),
            ...(options.getRestartControlRequired === undefined
                ? {}
                : {
                      getRestartControlRequired:
                          options.getRestartControlRequired,
                  }),
            ...(options.homeDirectory === undefined
                ? {}
                : { homeDirectory: options.homeDirectory }),
            ...(options.markRestartControlRequired === undefined
                ? {}
                : {
                      markRestartControlRequired:
                          options.markRestartControlRequired,
                  }),
            ...(options.mutationRunner === undefined
                ? {}
                : { mutationRunner: options.mutationRunner }),
            ...(options.registry === undefined
                ? {}
                : { registry: options.registry }),
            ...(options.runtimeApply === undefined
                ? {}
                : { runtimeApply: options.runtimeApply }),
            ...(options.runtimePreflight === undefined
                ? {}
                : { runtimePreflight: options.runtimePreflight }),
            ...(options.validator === undefined
                ? {}
                : { validator: options.validator }),
        };
    }
    if (fallback !== undefined) {
        return {
            configStore: { async write() {} },
            getConfig: () => {
                throw new Error(
                    "Testing ConfigEngine owns configuration access.",
                );
            },
            setConfig() {},
        };
    }
    throw new Error(
        "Testing ConfigEditorCoordinator requires engine or configStore/getConfig/setConfig.",
    );
}

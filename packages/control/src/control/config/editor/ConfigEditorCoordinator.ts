import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";
import {
    ConfigInputError,
    MASKED_CONFIG_TOKEN,
    applyConfigInstancePatch,
    applyConfigMcpPatch,
    applyConfigWebPatch,
    createError,
    errorCodes,
    formatConfigPath,
    normalizeConfigDraft,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    parseConfigBatchUpdateRequest,
    parseConfigDraft,
    parseConfigInstanceTargetRequest,
    parseConfigUpdateInstanceRequest,
    parseConfigUpdateMcpRequest,
    parseConfigUpdateWebRequest,
    toConfigView,
    type ConfigDraft,
    type ControlConfig,
    type JsonValue
} from "@portable-devshell/shared";

import { InstanceFactory } from "../../instance/InstanceFactory.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import { McpEndpointFactory } from "../../../composition/McpEndpointFactory.js";
import { ControlConfigValidator } from "../ControlConfigValidator.js";
import { ControlConfigMutationLock, type ControlConfigMutationRunner } from "../ControlConfigMutationLock.js";
import { HttpEndpointPreflight } from "../../../server/http/HttpEndpointPreflight.js";
import {
    buildApplyResult,
    requiresWorkerRebuild,
    toWorkerReconfigureInput
} from "./ConfigEditorResult.js";

interface ControlConfigWriter {
    write(config: ControlConfig, homeDirectory?: string): Promise<void>;
}

export interface ConfigRuntimeChangeSet {
    instanceAuth: boolean;
    mcp: boolean;
    web: boolean;
}

interface ConfigEditorCoordinatorOptions {
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    getMcpHost?: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    getRestartControlRequired?: () => boolean;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointFactory;
    markRestartControlRequired?: () => void;
    mutationRunner?: ControlConfigMutationRunner;
    runtimeApply?: { apply(previous: ControlConfig, next: ControlConfig, changes: ConfigRuntimeChangeSet): Promise<boolean> };
    setConfig: (config: ControlConfig) => void;
    runtimePreflight?: { assertAvailable(previous: ControlConfig, next: ControlConfig): Promise<void> };
    validator?: ControlConfigValidator;
}

export class ConfigEditorCoordinator {
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #getRestartControlRequired: () => boolean;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceFactory;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #instanceDeleteRetirements = new Set<(instance: ControlConfig["instances"][number]) => Promise<void>>();
    readonly #markRestartControlRequired: () => void;
    readonly #mcpEndpointConfigMapper: McpEndpointFactory;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #runtimePreflight: { assertAvailable(previous: ControlConfig, next: ControlConfig): Promise<void> };
    readonly #runtimeApply?: { apply(previous: ControlConfig, next: ControlConfig, changes: ConfigRuntimeChangeSet): Promise<boolean> };
    readonly #validator: ControlConfigValidator;

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost ?? (() => undefined);
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#getRestartControlRequired = options.getRestartControlRequired ?? (() => false);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
        this.#markRestartControlRequired = options.markRestartControlRequired ?? (() => undefined);
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointFactory();
        this.#mutationRunner = options.mutationRunner ?? new ControlConfigMutationLock();
        this.#setConfig = options.setConfig;
        this.#runtimePreflight = options.runtimePreflight ?? new HttpEndpointPreflight();
        this.#runtimeApply = options.runtimeApply;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void {
        this.#instanceDeleteRetirements.add(retire);
        return () => this.#instanceDeleteRetirements.delete(retire);
    }

    getConfigView(): JsonValue {
        return toConfigView(this.#getConfig(), this.#getRestartControlRequired()) as unknown as JsonValue;
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        const draft = this.#readConfigInput(() => parseConfigDraft(stripConfigViewMetadata(params)));
        const config = this.#readConfigInput(() => normalizeConfigDraft(this.#resolveMaskedTokens(draft)));
        return toConfigView(this.#validateConfig(config), this.#getRestartControlRequired()) as unknown as JsonValue;
    }

    async updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => await this.#updateConfig(params));
    }

    async #updateConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#readConfigInput(() => parseConfigBatchUpdateRequest(params));
        const currentConfig = this.#getConfig();
        const instanceRequest = request.instance;
        const existing = instanceRequest === undefined
            ? undefined
            : currentConfig.instances.find((entry) => entry.name === instanceRequest.instanceName);
        if (instanceRequest !== undefined && existing === undefined) {
            throw missingInstance(instanceRequest.instanceName);
        }

        const instance = existing === undefined || instanceRequest === undefined
            ? undefined
            : this.#readConfigInput(() =>
                  normalizeConfigInstanceDraft(applyConfigInstancePatch(existing, instanceRequest.patch))
              );
        const descriptor = instanceRequest === undefined ? undefined : this.#instanceRegistry.get(instanceRequest.instanceName);
        const rebuildRequired = existing !== undefined && instance !== undefined && descriptor !== undefined
            && requiresWorkerRebuild(existing, instance);
        const preparedDescriptor = instance === undefined
            ? undefined
            : this.#prepareInstanceDescriptor(instance, descriptor, rebuildRequired);
        const authChanged = existing !== undefined && instance !== undefined
            && JSON.stringify(existing.mcp.auth) !== JSON.stringify(instance.mcp.auth);
        if (rebuildRequired && instanceRequest !== undefined) {
            this.#assertInstanceStopped(instanceRequest.instanceName, "update");
        }

        const global = this.#readConfigInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.mcp ?? {}),
                web: applyConfigWebPatch(currentConfig.web, request.web ?? {})
            })
        );
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: instanceRequest === undefined || instance === undefined
                ? currentConfig.instances
                : currentConfig.instances.map((entry) =>
                      entry.name === instanceRequest.instanceName ? instance : entry
                  ),
            mcp: global.mcp,
            web: global.web
        });

        if (request.mcp !== undefined || request.web !== undefined) {
            await this.#runtimePreflight.assertAvailable(currentConfig, nextConfig);
        }
        const stoppedForDisable = await this.#stopForDisable(existing, instance, descriptor);
        let hotApplied = false;
        try {
            await this.#retireInteractionsForDisable(existing, instance, descriptor);
            await this.#persistConfig(nextConfig);

            const runtimeChanges: ConfigRuntimeChangeSet = {
                instanceAuth: authChanged,
                mcp: request.mcp !== undefined,
                web: request.web !== undefined
            };
            hotApplied = await this.#applyPersistedChanges({
                currentConfig,
                descriptor,
                existing,
                instance,
                nextConfig,
                preparedDescriptor,
                rebuildRequired,
                runtimeChanges
            });
        } catch (error) {
            await this.#restoreAfterFailedDisable(descriptor, stoppedForDisable, error);
        }

        const changes = [
            ...(instanceRequest === undefined
                ? []
                : [{ kind: "instance.updated" as const, target: instanceRequest.instanceName }]),
            ...(request.mcp === undefined
                ? []
                : [{ kind: "mcp.endpoint.updated" as const, target: "mcp" }]),
            ...(request.web === undefined
                ? []
                : [{ kind: "web.updated" as const, target: "web" }])
        ];
        return this.#finalizeApplyResult(currentConfig, nextConfig, changes, hotApplied);
    }

    async updateInstanceConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => await this.#updateInstanceConfig(params));
    }

    async #updateInstanceConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#readConfigInput(() => parseConfigUpdateInstanceRequest(params));
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === request.instanceName);
        if (existing === undefined) throw missingInstance(request.instanceName);

        const instance = this.#readConfigInput(() =>
            normalizeConfigInstanceDraft(applyConfigInstancePatch(existing, request.patch))
        );
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) => (entry.name === request.instanceName ? instance : entry))
        });
        const descriptor = this.#instanceRegistry.get(request.instanceName);
        const rebuildRequired = descriptor !== undefined && requiresWorkerRebuild(existing, instance);
        const preparedDescriptor = this.#prepareInstanceDescriptor(instance, descriptor, rebuildRequired);
        const authChanged = JSON.stringify(existing.mcp.auth) !== JSON.stringify(instance.mcp.auth);
        if (rebuildRequired) this.#assertInstanceStopped(request.instanceName, "update");

        const stoppedForDisable = await this.#stopForDisable(existing, instance, descriptor);
        let hotApplied = false;
        try {
            await this.#retireInteractionsForDisable(existing, instance, descriptor);
            await this.#persistConfig(nextConfig);
            hotApplied = await this.#applyPersistedChanges({
                currentConfig,
                descriptor,
                existing,
                instance,
                nextConfig,
                preparedDescriptor,
                rebuildRequired,
                runtimeChanges: {
                    instanceAuth: authChanged,
                    mcp: false,
                    web: false
                }
            });
        } catch (error) {
            await this.#restoreAfterFailedDisable(descriptor, stoppedForDisable, error);
        }
        return this.#finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.updated", target: request.instanceName }],
            hotApplied
        );
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => await this.#updateMcpConfig(params));
    }

    async #updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#readConfigInput(() => parseConfigUpdateMcpRequest(params));
        const currentConfig = this.#getConfig();
        const global = this.#readConfigInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.patch)
            })
        );
        const nextConfig = this.#validateConfig({ ...currentConfig, mcp: global.mcp });

        await this.#runtimePreflight.assertAvailable(currentConfig, nextConfig);
        await this.#persistConfig(nextConfig);
        const hotApplied = await this.#applyRuntimeOrRestore(currentConfig, nextConfig, {
            instanceAuth: false,
            mcp: true,
            web: false
        });
        return this.#finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "mcp.endpoint.updated", target: "mcp" }],
            hotApplied
        );
    }

    async updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => await this.#updateWebConfig(params));
    }

    async #updateWebConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#readConfigInput(() => parseConfigUpdateWebRequest(params));
        const currentConfig = this.#getConfig();
        const global = this.#readConfigInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: currentConfig.mcp,
                web: applyConfigWebPatch(currentConfig.web, request.patch)
            })
        );
        const nextConfig = this.#validateConfig({ ...currentConfig, web: global.web });
        await this.#runtimePreflight.assertAvailable(currentConfig, nextConfig);
        await this.#persistConfig(nextConfig);
        const webHotApplied = await this.#applyRuntimeOrRestore(currentConfig, nextConfig, {
            instanceAuth: false,
            mcp: false,
            web: true
        });
        return this.#finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "web.updated", target: "web" }],
            webHotApplied
        );
    }

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => await this.#deleteInstance(params));
    }

    async #deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        const { instanceName } = this.#readConfigInput(() => parseConfigInstanceTargetRequest(params));
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === instanceName);
        if (existing === undefined) throw missingInstance(instanceName);

        this.#assertInstanceStopped(instanceName, "delete");
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.filter((entry) => entry.name !== instanceName)
        });

        for (const retire of [...this.#instanceDeleteRetirements]) {
            await retire(existing);
        }
        await this.#retireStateForDelete(this.#instanceRegistry.get(instanceName));
        await this.#getMcpHost()?.contextAdmin.detachInstance(instanceName);
        await this.#persistConfig(nextConfig);
        this.#getMcpHost()?.unregisterInstance(instanceName);
        this.#instanceRegistry.delete(instanceName);
        return this.#finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.deleted", target: instanceName }]
        );
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => {
            const { instanceName } = this.#readConfigInput(() => parseConfigInstanceTargetRequest(params));
            return await this.#setInstanceEnabled(instanceName, true);
        });
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#mutationRunner.runExclusive(async () => {
            const { instanceName } = this.#readConfigInput(() => parseConfigInstanceTargetRequest(params));
            return await this.#setInstanceEnabled(instanceName, false);
        });
    }

    async #setInstanceEnabled(instanceName: string, enabled: boolean): Promise<JsonValue> {
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === instanceName);
        if (existing === undefined) throw missingInstance(instanceName);

        const instance = normalizeConfigInstanceDraft(applyConfigInstancePatch(existing, { enabled }));
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) => (entry.name === instanceName ? instance : entry))
        });
        const descriptor = this.#instanceRegistry.get(instanceName);
        const preparedDescriptor = this.#prepareInstanceDescriptor(instance, descriptor, false);
        const stoppedForDisable = await this.#stopForDisable(existing, instance, descriptor);
        try {
            await this.#retireInteractionsForDisable(existing, instance, descriptor);
            await this.#persistConfig(nextConfig);
            await this.#applyPersistedChanges({
                currentConfig,
                descriptor,
                existing,
                instance,
                nextConfig,
                preparedDescriptor,
                rebuildRequired: false,
                runtimeChanges: { instanceAuth: false, mcp: false, web: false }
            });
        } catch (error) {
            await this.#restoreAfterFailedDisable(descriptor, stoppedForDisable, error);
        }
        return this.#finalizeApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: enabled ? "instance.enabled" : "instance.disabled", target: instanceName }]
        );
    }

    async #retireStateForDelete(
        descriptor: ReturnType<InstanceRegistry["get"]>,
    ): Promise<void> {
        if (descriptor === undefined) return;
        const reason = `Instance ${descriptor.name} was deleted.`;

        for (const approval of await descriptor.worker.listApprovals()) {
            if (approval.status === "pending") {
                await descriptor.worker.cancelApproval(approval.approvalId, reason);
            }
        }

        if (descriptor.wait !== undefined) {
            for (const wait of await descriptor.wait.list()) {
                if (wait.status === "waiting" || wait.status === "detached") {
                    try {
                        await descriptor.wait.cancel(wait.waitId);
                    } catch (error) {
                        const current = await descriptor.wait.get(wait.waitId);
                        if (
                            current === undefined || current.status === "cancelled" ||
                            current.status === "consumed" || current.status === "resolved"
                        ) continue;
                        throw error;
                    }
                } else if (wait.status === "resolved") {
                    try {
                        await descriptor.wait.consume(wait.waitId);
                    } catch (error) {
                        const current = await descriptor.wait.get(wait.waitId);
                        if (
                            current === undefined || current.status === "cancelled" ||
                            current.status === "consumed"
                        ) continue;
                        throw error;
                    }
                }
            }
        }

        await descriptor.contextMessages?.failAllPending(
            `Instance ${descriptor.name} was deleted before Comment delivery.`,
        );
        await descriptor.goal.stopAll();
        await descriptor.todo.cancelAll();
        await descriptor.worker.retireRuntime();
        await descriptor.worker.retireProviderResources();
    }

    async #retireInteractionsForDisable(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: ReturnType<InstanceRegistry["get"]>,
    ): Promise<void> {
        if (
            existing === undefined || next === undefined || descriptor === undefined ||
            !existing.enabled || next.enabled
        ) return;

        for (const approval of await descriptor.worker.listApprovals()) {
            if (approval.status === "pending") {
                await descriptor.worker.cancelApproval(
                    approval.approvalId,
                    `Instance ${descriptor.name} was disabled before approval.`,
                );
            }
        }

        if (descriptor.wait === undefined) return;
        for (const wait of await descriptor.wait.list()) {
            if (wait.status !== "waiting" && wait.status !== "detached") continue;
            try {
                await descriptor.wait.cancel(wait.waitId);
            } catch (error) {
                const current = await descriptor.wait.get(wait.waitId);
                if (
                    current === undefined || current.status === "cancelled" ||
                    current.status === "consumed" || current.status === "resolved"
                ) continue;
                throw error;
            }
        }
    }

    async #stopForDisable(
        existing: ControlConfig["instances"][number] | undefined,
        next: ControlConfig["instances"][number] | undefined,
        descriptor: ReturnType<InstanceRegistry["get"]>,
    ): Promise<boolean> {
        if (
            existing === undefined || next === undefined || descriptor === undefined ||
            !existing.enabled || next.enabled || descriptor.worker.managementMode === "selfManaged"
        ) return false;
        if (descriptor.worker.snapshot().daemonState === "stopped") return false;
        await descriptor.worker.stop();
        return true;
    }

    async #restoreAfterFailedDisable(
        descriptor: ReturnType<InstanceRegistry["get"]>,
        stoppedForDisable: boolean,
        error: unknown,
    ): Promise<never> {
        if (!stoppedForDisable || descriptor === undefined) throw error;
        try {
            await descriptor.worker.start();
        } catch (restoreError) {
            throw new AggregateError(
                [error, restoreError],
                `Disabling ${descriptor.name} failed and the previous running state could not be restored.`,
            );
        }
        throw error;
    }

    async #applyPersistedChanges(input: {
        currentConfig: ControlConfig;
        descriptor: ReturnType<InstanceRegistry["get"]>;
        existing?: ControlConfig["instances"][number];
        instance?: ControlConfig["instances"][number];
        nextConfig: ControlConfig;
        preparedDescriptor?: ReturnType<InstanceFactory["map"]>;
        rebuildRequired: boolean;
        runtimeChanges: ConfigRuntimeChangeSet;
    }): Promise<boolean> {
        let hotApplied = false;
        try {
            const runtimeChanged = input.runtimeChanges.instanceAuth || input.runtimeChanges.mcp || input.runtimeChanges.web;
            hotApplied = runtimeChanged
                ? await this.#applyRuntimeOrRestore(input.currentConfig, input.nextConfig, input.runtimeChanges)
                : false;
            if (input.existing !== undefined && input.instance !== undefined) {
                await this.#applyInstanceConfig(
                    input.instance,
                    input.descriptor,
                    input.rebuildRequired,
                    input.preparedDescriptor
                );
                await this.#syncMcpEndpoint(input.instance.name);
            }
            return hotApplied;
        } catch (error) {
            const failures: unknown[] = [error];
            if (hotApplied && this.#runtimeApply !== undefined) {
                await this.#runtimeApply.apply(input.nextConfig, input.currentConfig, input.runtimeChanges)
                    .catch((rollbackError) => failures.push(rollbackError));
            }
            if (this.#getConfig() !== input.currentConfig) {
                await this.#persistConfig(input.currentConfig).catch((rollbackError) => failures.push(rollbackError));
            }
            if (input.existing !== undefined && input.instance !== undefined) {
                await this.#restoreInstanceRuntime(
                    input.existing,
                    input.descriptor,
                    input.preparedDescriptor
                ).catch((rollbackError) => failures.push(rollbackError));
                try {
                    await this.#syncMcpEndpoint(input.existing.name);
                } catch (rollbackError) {
                    failures.push(rollbackError);
                }
            } else if (input.preparedDescriptor !== undefined) {
                await closeWorkerBestEffort(input.preparedDescriptor).catch((rollbackError) => failures.push(rollbackError));
            }
            if (failures.length === 1) throw error;
            throw new AggregateError(failures, "Configuration update failed and runtime rollback was incomplete.");
        }
    }

    async #restoreInstanceRuntime(
        existing: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined
    ): Promise<void> {
        const failures: unknown[] = [];
        if (descriptor === undefined) {
            this.#instanceRegistry.delete(existing.name);
        } else {
            this.#instanceRegistry.add(descriptor);
            try {
                await descriptor.worker.reconfigure(toWorkerReconfigureInput(existing));
                descriptor.mcpCapabilities = [...existing.mcp.tools.capabilities];
                descriptor.mcpContextMode = existing.mcp.contextMode;
                descriptor.mcpGroups = [...existing.mcp.tools.groups];
                descriptor.enabled = existing.enabled;
                descriptor.mcpEnabled = existing.mcp.enabled;
                descriptor.mcpPath = existing.mcp.path;
            } catch (error) {
                failures.push(error);
            }
        }
        if (preparedDescriptor !== undefined && preparedDescriptor !== descriptor) {
            await closeWorkerBestEffort(preparedDescriptor).catch((error) => failures.push(error));
        }
        if (failures.length > 0) throw new AggregateError(failures, `Failed to restore instance ${existing.name}.`);
    }

    #prepareInstanceDescriptor(
        instance: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        rebuildRequired: boolean
    ): ReturnType<InstanceFactory["map"]> | undefined {
        if (!instance.enabled) return undefined;
        if (descriptor === undefined || rebuildRequired) return this.#instanceConfigMapper.map(instance);
        return undefined;
    }

    async #applyInstanceConfig(
        instance: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        rebuildRequired: boolean,
        preparedDescriptor: ReturnType<InstanceFactory["map"]> | undefined
    ): Promise<void> {
        if (descriptor === undefined) {
            if (instance.enabled && preparedDescriptor !== undefined) this.#instanceRegistry.add(preparedDescriptor);
            return;
        }
        if (rebuildRequired) {
            if (preparedDescriptor === undefined) throw new Error(`Missing prepared descriptor for ${instance.name}.`);
            this.#instanceRegistry.add(preparedDescriptor);
            return;
        }
        if (instance.enabled) {
            await descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        }
        descriptor.mcpCapabilities = [...instance.mcp.tools.capabilities];
        descriptor.mcpContextMode = instance.mcp.contextMode;
        descriptor.mcpGroups = [...instance.mcp.tools.groups];
        descriptor.enabled = instance.enabled;
        descriptor.mcpEnabled = instance.mcp.enabled;
        descriptor.mcpPath = instance.mcp.path;
    }

    async #syncMcpEndpoint(instanceName: string): Promise<void> {
        const host = this.#getMcpHost();
        if (host === undefined) return;
        const config = this.#getConfig();
        const instance = config.instances.find((entry) => entry.name === instanceName);
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (instance?.mcp.tools.groups.includes("workspace") !== true) {
            await host.retireWorkspaceApp(instanceName);
        }
        if (
            !config.mcp.enabled ||
            instance === undefined ||
            !instance.enabled ||
            !instance.mcp.enabled ||
            descriptor === undefined
        ) {
            host.unregisterInstance(instanceName);
            return;
        }
        host.registerInstance(this.#mcpEndpointConfigMapper.map(descriptor, this.#getMcpInstanceGateway(), instance.mcp.auth));
    }

    #assertInstanceStopped(instanceName: string, operation: "delete" | "disable" | "update"): void {
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (descriptor === undefined) return;
        const snapshot = descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") return;
        throw createError({
            code: errorCodes.instanceConflict,
            details: { instance: instanceName, operation, status: snapshot.status },
            message: `Instance ${instanceName} must be stopped before ${operation}.`,
            retryable: false
        });
    }

    async #persistConfig(config: ControlConfig): Promise<void> {
        await this.#configStore.write(config, this.#homeDirectory);
        this.#setConfig(config);
    }

    async #applyRuntimeOrRestore(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet
    ): Promise<boolean> {
        if (this.#runtimeApply === undefined) return false;
        try {
            return await this.#runtimeApply.apply(previous, next, changes);
        } catch (error) {
            await this.#persistConfig(previous);
            throw error;
        }
    }

    #finalizeApplyResult(
        previous: ControlConfig,
        next: ControlConfig,
        changes: Parameters<typeof buildApplyResult>[2],
        hotApplied = false
    ): JsonValue {
        const result = buildApplyResult(previous, next, changes, hotApplied);
        if (result.restartControlRequired) this.#markRestartControlRequired();
        return result as unknown as JsonValue;
    }

    #validateConfig(config: ControlConfig): ControlConfig {
        return this.#validator.validate(config);
    }

    #resolveMaskedTokens(draft: ConfigDraft): ConfigDraft {
        const current = this.#getConfig();
        const webAuth = current.web.auth;
        const web = draft.web?.token === MASKED_CONFIG_TOKEN && webAuth.mode === "token"
            ? { ...draft.web, token: webAuth.token }
            : draft.web;
        const instances = draft.instances?.map((instance) => {
            if (instance.mcp?.token !== MASKED_CONFIG_TOKEN) return instance;
            const existing = current.instances.find((candidate) => candidate.name === instance.name);
            if (existing?.mcp.auth.mode !== "token") return instance;
            return { ...instance, mcp: { ...instance.mcp, token: existing.mcp.auth.token } };
        });
        return { ...draft, web, instances };
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

async function closeWorkerBestEffort(descriptor: ReturnType<InstanceFactory["map"]>): Promise<void> {
    const close = (descriptor.worker as { close?: () => Promise<void> }).close;
    if (close !== undefined) await close.call(descriptor.worker);
}

function stripConfigViewMetadata(value: JsonValue | undefined): JsonValue | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
    const { restartControlRequired: _restartControlRequired, ...config } = value;
    return config;
}

function missingInstance(instanceName: string): Error {
    return createError({
        code: errorCodes.instanceMissing,
        details: { instance: instanceName },
        message: `Instance ${instanceName} was not found.`,
        retryable: false
    });
}

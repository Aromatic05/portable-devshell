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

interface ConfigEditorCoordinatorOptions {
    configStore: ControlConfigWriter;
    getConfig: () => ControlConfig;
    getMcpHost?: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointFactory;
    mutationRunner?: ControlConfigMutationRunner;
    runtimeApply?: { apply(previous: ControlConfig, next: ControlConfig): Promise<boolean> };
    setConfig: (config: ControlConfig) => void;
    runtimePreflight?: { assertAvailable(previous: ControlConfig, next: ControlConfig): Promise<void> };
    validator?: ControlConfigValidator;
}

export class ConfigEditorCoordinator {
    readonly #configStore: ControlConfigWriter;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceFactory;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointFactory;
    readonly #mutationRunner: ControlConfigMutationRunner;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #runtimePreflight: { assertAvailable(previous: ControlConfig, next: ControlConfig): Promise<void> };
    readonly #runtimeApply?: { apply(previous: ControlConfig, next: ControlConfig): Promise<boolean> };
    readonly #validator: ControlConfigValidator;

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost ?? (() => undefined);
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointFactory();
        this.#mutationRunner = options.mutationRunner ?? new ControlConfigMutationLock();
        this.#setConfig = options.setConfig;
        this.#runtimePreflight = options.runtimePreflight ?? new HttpEndpointPreflight();
        this.#runtimeApply = options.runtimeApply;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getConfigView(): JsonValue {
        return toConfigView(this.#getConfig()) as unknown as JsonValue;
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        const draft = this.#readConfigInput(() => parseConfigDraft(params));
        const config = this.#readConfigInput(() => normalizeConfigDraft(this.#resolveMaskedWebToken(draft)));
        return toConfigView(this.#validateConfig(config)) as unknown as JsonValue;
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
        await this.#persistConfig(nextConfig);

        const runtimeChanged = request.mcp !== undefined || request.web !== undefined || authChanged;
        const hotApplied = runtimeChanged
            ? await this.#applyRuntimeOrRestore(currentConfig, nextConfig)
            : false;
        if (existing !== undefined && instance !== undefined) {
            this.#applyInstanceConfig(instance, descriptor, rebuildRequired);
            this.#syncMcpEndpoint(instance.name);
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
        return buildApplyResult(currentConfig, nextConfig, changes, hotApplied) as unknown as JsonValue;
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
        const authChanged = JSON.stringify(existing.mcp.auth) !== JSON.stringify(instance.mcp.auth);
        if (rebuildRequired) this.#assertInstanceStopped(request.instanceName, "update");

        await this.#persistConfig(nextConfig);

        const hotApplied = authChanged && this.#runtimeApply !== undefined
            ? await this.#applyRuntimeOrRestore(currentConfig, nextConfig)
            : false;
        this.#applyInstanceConfig(instance, descriptor, rebuildRequired);
        this.#syncMcpEndpoint(request.instanceName);
        return buildApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.updated", target: request.instanceName }],
            hotApplied
        ) as unknown as JsonValue;
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
        const hotApplied = await this.#applyRuntimeOrRestore(currentConfig, nextConfig);
        return buildApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "mcp.endpoint.updated", target: "mcp" }],
            hotApplied
        ) as unknown as JsonValue;
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
        const webHotApplied = await this.#applyRuntimeOrRestore(currentConfig, nextConfig);
        return buildApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "web.updated", target: "web" }],
            webHotApplied
        ) as unknown as JsonValue;
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

        await this.#persistConfig(nextConfig);
        this.#getMcpHost()?.unregisterInstance(instanceName);
        this.#instanceRegistry.delete(instanceName);
        return buildApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: "instance.deleted", target: instanceName }]
        ) as unknown as JsonValue;
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
        await this.#persistConfig(nextConfig);

        const descriptor = this.#instanceRegistry.get(instanceName);
        if (enabled) {
            if (descriptor === undefined) this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            else descriptor.enabled = true;
        } else if (descriptor !== undefined) {
            descriptor.enabled = false;
        }

        this.#syncMcpEndpoint(instanceName);
        return buildApplyResult(
            currentConfig,
            nextConfig,
            [{ kind: enabled ? "instance.enabled" : "instance.disabled", target: instanceName }]
        ) as unknown as JsonValue;
    }

    #applyInstanceConfig(
        instance: ControlConfig["instances"][number],
        descriptor: ReturnType<InstanceRegistry["get"]>,
        rebuildRequired: boolean
    ): void {
        if (descriptor === undefined) {
            if (instance.enabled) this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            return;
        }
        if (rebuildRequired) {
            this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            return;
        }
        descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        descriptor.mcpCapabilities = [...instance.mcp.tools.capabilities];
        descriptor.mcpGroups = [...instance.mcp.tools.groups];
        descriptor.enabled = instance.enabled;
        descriptor.mcpEnabled = instance.mcp.enabled;
        descriptor.mcpPath = instance.mcp.path;
    }

    #syncMcpEndpoint(instanceName: string): void {
        const host = this.#getMcpHost();
        if (host === undefined) return;
        const config = this.#getConfig();
        const instance = config.instances.find((entry) => entry.name === instanceName);
        const descriptor = this.#instanceRegistry.get(instanceName);
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

    async #applyRuntimeOrRestore(previous: ControlConfig, next: ControlConfig): Promise<boolean> {
        if (this.#runtimeApply === undefined) return false;
        try {
            return await this.#runtimeApply.apply(previous, next);
        } catch (error) {
            await this.#persistConfig(previous);
            throw error;
        }
    }

    #validateConfig(config: ControlConfig): ControlConfig {
        return this.#validator.validate(config);
    }

    #resolveMaskedWebToken(draft: ConfigDraft): ConfigDraft {
        const auth = this.#getConfig().web.auth;
        if (draft.web?.token !== MASKED_CONFIG_TOKEN || auth.mode !== "token") return draft;
        return { ...draft, web: { ...draft.web, token: auth.token } };
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

function missingInstance(instanceName: string): Error {
    return createError({
        code: errorCodes.instanceMissing,
        details: { instance: instanceName },
        message: `Instance ${instanceName} was not found.`,
        retryable: false
    });
}

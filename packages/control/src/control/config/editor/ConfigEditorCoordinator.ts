import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";
import {
    ConfigInputError,
    applyConfigInstancePatch,
    applyConfigMcpPatch,
    createError,
    errorCodes,
    formatConfigPath,
    normalizeConfigDraft,
    normalizeConfigGlobalDraft,
    normalizeConfigInstanceDraft,
    parseConfigDraft,
    parseConfigInstanceTargetRequest,
    parseConfigUpdateInstanceRequest,
    parseConfigUpdateMcpRequest,
    toConfigView,
    type ControlConfig,
    type JsonValue
} from "@portable-devshell/shared";

import { InstanceFactory } from "../../instance/InstanceFactory.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import { McpEndpointFactory } from "../../../composition/McpEndpointFactory.js";
import { ControlConfigValidator } from "../ControlConfigValidator.js";
import {
    buildApplyResult,
    emptyApplyResult,
    mergeApplyResults,
    requiresWorkerRebuild,
    toWorkerReconfigureInput,
    type ConfigApplyResult
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
    setConfig: (config: ControlConfig) => void;
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
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;
    #lastApplyResult: ConfigApplyResult = emptyApplyResult();

    constructor(options: ConfigEditorCoordinatorOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost ?? (() => undefined);
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceFactory();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointFactory();
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getConfigView(): JsonValue {
        return toConfigView(this.#getConfig()) as unknown as JsonValue;
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        const config = this.#readConfigInput(() => normalizeConfigDraft(parseConfigDraft(params)));
        return toConfigView(this.#validateConfig(config)) as unknown as JsonValue;
    }

    async updateInstanceConfig(params: JsonValue | undefined): Promise<JsonValue> {
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
        if (rebuildRequired) this.#assertInstanceStopped(request.instanceName, "update");

        await this.#persistConfig(nextConfig);

        if (descriptor === undefined) {
            if (instance.enabled) this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
        } else if (rebuildRequired) {
            this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
        } else {
            descriptor.mcpCapabilities = [...instance.mcp.tools.capabilities];
            descriptor.mcpGroups = [...instance.mcp.tools.groups];
            descriptor.enabled = instance.enabled;
            descriptor.mcpEnabled = instance.mcp.enabled;
            descriptor.mcpPath = instance.mcp.path;
            descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        }
        this.#syncMcpEndpoint(request.instanceName);
        this.#rememberApplyResult(
            buildApplyResult(currentConfig, nextConfig, [{ kind: "instance.updated", target: request.instanceName }])
        );
        return this.getConfigView();
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const request = this.#readConfigInput(() => parseConfigUpdateMcpRequest(params));
        const currentConfig = this.#getConfig();
        const global = this.#readConfigInput(() =>
            normalizeConfigGlobalDraft({
                control: currentConfig.control,
                mcp: applyConfigMcpPatch(currentConfig.mcp, request.patch)
            })
        );
        const nextConfig = this.#validateConfig({ ...currentConfig, mcp: global.mcp });

        await this.#persistConfig(nextConfig);
        this.#rememberApplyResult(buildApplyResult(currentConfig, nextConfig, [{ kind: "mcp.updated", target: "mcp" }]));
        return this.getConfigView();
    }

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
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
        this.#rememberApplyResult(
            buildApplyResult(currentConfig, nextConfig, [{ kind: "instance.deleted", target: instanceName }])
        );
        return this.getConfigView();
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        const { instanceName } = this.#readConfigInput(() => parseConfigInstanceTargetRequest(params));
        return await this.#setInstanceEnabled(instanceName, true);
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        const { instanceName } = this.#readConfigInput(() => parseConfigInstanceTargetRequest(params));
        return await this.#setInstanceEnabled(instanceName, false);
    }

    applyConfig(): JsonValue {
        const result = this.#lastApplyResult;
        this.#lastApplyResult = emptyApplyResult();
        return result as unknown as JsonValue;
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
        this.#rememberApplyResult(
            buildApplyResult(currentConfig, nextConfig, [
                { kind: enabled ? "instance.enabled" : "instance.disabled", target: instanceName }
            ])
        );
        return this.getConfigView();
    }

    #syncMcpEndpoint(instanceName: string): void {
        const host = this.#getMcpHost();
        if (host === undefined) return;
        const instance = this.#getConfig().instances.find((entry) => entry.name === instanceName);
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (instance === undefined || !instance.enabled || !instance.mcp.enabled || descriptor === undefined) {
            host.unregisterInstance(instanceName);
            return;
        }
        host.registerInstance(this.#mcpEndpointConfigMapper.map(descriptor, this.#getMcpInstanceGateway()));
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

    #validateConfig(config: ControlConfig): ControlConfig {
        return this.#validator.validate(config);
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

    #rememberApplyResult(result: ConfigApplyResult): void {
        this.#lastApplyResult = mergeApplyResults(this.#lastApplyResult, result);
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

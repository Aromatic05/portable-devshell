import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";
import type { McpHost, McpInstanceGateway } from "@portable-devshell/mcp";

import { InstanceConfigMapper } from "../../instance/InstanceConfigMapper.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import { McpEndpointConfigMapper } from "../../mcp/McpEndpointConfigMapper.js";
import { ControlConfigStore } from "../config/ControlConfigStore.js";
import type { ControlConfig } from "../config/codec/ConfigTomlCodec.js";
import { ControlConfigValidator } from "../config/ControlConfigValidator.js";
import { readConfigDraft, readInstanceConfig, readInstanceName, readMcpConfig } from "./ConfigEditorDraft.js";
import {
    buildApplyResult,
    emptyApplyResult,
    mergeApplyResults,
    requiresWorkerRebuild,
    toWorkerReconfigureInput,
    type ConfigApplyResult
} from "./ConfigEditorResult.js";
import { toConfigView } from "./ConfigEditorView.js";

interface ControlConfigEditorServiceOptions {
    configStore: ControlConfigStore;
    getConfig: () => ControlConfig;
    getMcpHost?: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceConfigMapper;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointConfigMapper;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}


export class ControlConfigEditorService {
    readonly #configStore: ControlConfigStore;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceConfigMapper;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointConfigMapper;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;
    #lastApplyResult: ConfigApplyResult = emptyApplyResult();

    constructor(options: ControlConfigEditorServiceOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost ?? (() => undefined);
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceConfigMapper();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointConfigMapper();
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getConfigView(): JsonValue {
        return toConfigView(this.#getConfig()) as unknown as JsonValue;
    }

    validateConfigDraft(params: JsonValue | undefined): JsonValue {
        return toConfigView(this.#validateConfig(readConfigDraft(params, this.#getConfig()))) as unknown as JsonValue;
    }

    async updateInstanceConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const instance = readInstanceConfig(params, this.#getConfig());
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === instance.name);

        if (existing === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: instance.name },
                message: `Instance ${instance.name} was not found.`,
                retryable: false
            });
        }

        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) => (entry.name === instance.name ? instance : entry))
        });
        const descriptor = this.#instanceRegistry.get(instance.name);
        const rebuildRequired = descriptor !== undefined && requiresWorkerRebuild(existing, instance);
        if (rebuildRequired) {
            this.#assertInstanceStopped(instance.name, "update");
        }

        await this.#persistConfig(nextConfig);

        if (descriptor === undefined) {
            if (instance.enabled) {
                this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            }
        } else if (rebuildRequired) {
            this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
        } else {
            descriptor.mcpCapabilities = [...instance.mcp.tools.capabilities];
            descriptor.mcpGroups = [...instance.mcp.tools.groups];
            descriptor.enabled = instance.enabled;
            descriptor.mcpEnabled = instance.mcp.enabled;
            descriptor.mcpPath = instance.mcp.path ?? `/${instance.name}/mcp`;
            descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        }
        this.#syncMcpEndpoint(instance.name);
        this.#rememberApplyResult(buildApplyResult(currentConfig, nextConfig, [{ kind: "instance.updated", target: instance.name }]));
        return this.getConfigView();
    }

    async updateMcpConfig(params: JsonValue | undefined): Promise<JsonValue> {
        const currentConfig = this.#getConfig();
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            mcp: readMcpConfig(params, currentConfig)
        });

        await this.#persistConfig(nextConfig);
        this.#rememberApplyResult(buildApplyResult(currentConfig, nextConfig, [{ kind: "mcp.updated", target: "mcp" }]));
        return this.getConfigView();
    }

    async deleteInstance(params: JsonValue | undefined): Promise<JsonValue> {
        const instanceName = readInstanceName(params, "control.deleteInstance");
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === instanceName);

        if (existing === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: instanceName },
                message: `Instance ${instanceName} was not found.`,
                retryable: false
            });
        }

        this.#assertInstanceStopped(instanceName, "delete");
        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.filter((entry) => entry.name !== instanceName)
        });

        await this.#persistConfig(nextConfig);
        this.#getMcpHost()?.unregisterInstance(instanceName);
        this.#instanceRegistry.delete(instanceName);
        this.#rememberApplyResult(buildApplyResult(currentConfig, nextConfig, [{ kind: "instance.deleted", target: instanceName }]));
        return this.getConfigView();
    }

    async enableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#setInstanceEnabled(readInstanceName(params, "control.enableInstance"), true);
    }

    async disableInstance(params: JsonValue | undefined): Promise<JsonValue> {
        return await this.#setInstanceEnabled(readInstanceName(params, "control.disableInstance"), false);
    }

    applyConfig(): JsonValue {
        const result = this.#lastApplyResult;
        this.#lastApplyResult = emptyApplyResult();
        return result as unknown as JsonValue;
    }

    async #setInstanceEnabled(instanceName: string, enabled: boolean): Promise<JsonValue> {
        const currentConfig = this.#getConfig();
        const existing = currentConfig.instances.find((entry) => entry.name === instanceName);

        if (existing === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance: instanceName },
                message: `Instance ${instanceName} was not found.`,
                retryable: false
            });
        }

        const nextConfig = this.#validateConfig({
            ...currentConfig,
            instances: currentConfig.instances.map((entry) => (entry.name === instanceName ? { ...entry, enabled } : entry))
        });

        await this.#persistConfig(nextConfig);

        const instance = nextConfig.instances.find((entry) => entry.name === instanceName)!;
        const descriptor = this.#instanceRegistry.get(instanceName);

        if (enabled) {
            if (descriptor === undefined) {
                this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            } else {
                descriptor.enabled = true;
            }
        } else if (descriptor !== undefined) {
            descriptor.enabled = false;
        }

        this.#syncMcpEndpoint(instanceName);
        this.#rememberApplyResult(
            buildApplyResult(currentConfig, nextConfig, [{ kind: enabled ? "instance.enabled" : "instance.disabled", target: instanceName }])
        );
        return this.getConfigView();
    }

    #syncMcpEndpoint(instanceName: string): void {
        const host = this.#getMcpHost();
        if (host === undefined) {
            return;
        }
        const instance = this.#getConfig().instances.find((entry) => entry.name === instanceName);
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (
            instance === undefined ||
            !instance.enabled ||
            !instance.mcp.enabled ||
            descriptor === undefined
        ) {
            host.unregisterInstance(instanceName);
            return;
        }
        host.registerInstance(
            this.#mcpEndpointConfigMapper.map(descriptor, this.#getMcpInstanceGateway())
        );
    }

    #assertInstanceStopped(instanceName: string, operation: "delete" | "disable" | "update"): void {
        const descriptor = this.#instanceRegistry.get(instanceName);
        if (descriptor === undefined) {
            return;
        }

        const snapshot = descriptor.worker.snapshot();
        if (snapshot.daemonState === "stopped") {
            return;
        }

        throw createError({
            code: errorCodes.instanceConflict,
            details: {
                instance: instanceName,
                operation,
                status: snapshot.status
            },
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

    #rememberApplyResult(result: ConfigApplyResult): void {
        this.#lastApplyResult = mergeApplyResults(this.#lastApplyResult, result);
    }
}

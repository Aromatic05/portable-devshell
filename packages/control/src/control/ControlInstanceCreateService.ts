import { createError, errorCodes, type InstanceCreateResult, type InstanceCreateSchema, type InstanceCreateSummary, type JsonValue } from "@portable-devshell/shared";
import type { McpHost } from "@portable-devshell/mcp";

import { InstanceConfigMapper } from "../instance/InstanceConfigMapper.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { McpEndpointConfigMapper } from "../mcp/McpEndpointConfigMapper.js";
import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type { ControlConfig, ControlInstanceConfig, ControlProviderKind } from "./config/ControlConfigTomlCodec.js";
import { ControlConfigValidator } from "./config/ControlConfigValidator.js";

const instanceCreateSchema: InstanceCreateSchema = {
    defaultAllowTools: ["bash_run"],
    defaultEnabled: true,
    defaultEventBufferSize: 1_000,
    defaultMcpEnabled: true,
    defaultProvider: "local",
    defaultRetentionDays: 7,
    defaultSecurityMode: "disabled",
    providers: ["local", "ssh", "docker", "podman"]
};

export interface ControlInstanceCreateServiceOptions {
    configStore: ControlConfigStore;
    getConfig: () => ControlConfig;
    getMcpHost: () => McpHost | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceConfigMapper;
    instanceRegistry: InstanceRegistry;
    mcpEndpointConfigMapper?: McpEndpointConfigMapper;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

export class ControlInstanceCreateService {
    readonly #configStore: ControlConfigStore;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceConfigMapper;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointConfigMapper;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;

    constructor(options: ControlInstanceCreateServiceOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost;
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceConfigMapper();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointConfigMapper();
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getSchema(): InstanceCreateSchema {
        return instanceCreateSchema;
    }

    validateDraft(params: JsonValue | undefined): InstanceCreateSummary {
        const normalized = this.#normalizeDraft(params);
        this.#validateMergedConfig(normalized);
        return toSummary(normalized);
    }

    async createInstance(params: JsonValue | undefined): Promise<InstanceCreateResult> {
        const normalized = this.#normalizeDraft(params);
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
            this.#getMcpHost()?.registerInstance(this.#mcpEndpointConfigMapper.map(descriptor));
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

        const nextConfig: ControlConfig = {
            ...currentConfig,
            instances: [...currentConfig.instances, instance]
        };

        try {
            return this.#validator.validate(nextConfig);
        } catch (error) {
            throw toConfigInvalidError(error);
        }
    }

    #normalizeDraft(params: JsonValue | undefined): ControlInstanceConfig {
        const draft = asDraftRecord(params);
        const name = readRequiredString(draft.name, "name");
        const provider = readProvider(draft.provider);

        const normalized: ControlInstanceConfig = {
            defaultWorkspace: readOptionalString(draft.defaultWorkspace, "defaultWorkspace"),
            dockerBinary: readOptionalString(draft.dockerBinary, "dockerBinary"),
            enabled: readBoolean(draft.enabled, instanceCreateSchema.defaultEnabled, "enabled"),
            env: readEnv(draft.env),
            host: readOptionalString(draft.host, "host"),
            logs: readLogs(draft.logs),
            mcp: {
                allowTools: readAllowTools(draft.mcp),
                enabled: readNestedBoolean(draft.mcp, "enabled", instanceCreateSchema.defaultMcpEnabled),
                path: `/${name}/mcp`
            },
            name,
            podmanBinary: readOptionalString(draft.podmanBinary, "podmanBinary"),
            provider,
            remoteCwd: readOptionalString(draft.remoteCwd, "remoteCwd"),
            security: {
                mode: readSecurityMode(draft.security)
            },
            sshBinary: readOptionalString(draft.sshBinary, "sshBinary"),
            workerBinaryPath: readOptionalString(draft.workerBinaryPath, "workerBinaryPath")
        };

        switch (provider) {
            case "local":
                break;
            case "ssh":
                normalized.host = readRequiredString(draft.host, "host");
                break;
            case "docker":
            case "podman":
                normalized.container = readRequiredString(draft.container, "container");
                break;
        }

        return normalized;
    }
}

function asDraftRecord(params: JsonValue | undefined): Record<string, JsonValue> {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw invalidDraft("instance create draft must be an object.");
    }

    return params as Record<string, JsonValue>;
}

function readProvider(value: JsonValue | undefined): ControlProviderKind {
    if (value === "local" || value === "ssh" || value === "docker" || value === "podman") {
        return value;
    }

    throw invalidDraft("provider must be one of local, ssh, docker, podman.");
}

function readRequiredString(value: JsonValue | undefined, fieldName: string): string {
    const normalized = readOptionalString(value, fieldName);

    if (normalized === undefined) {
        throw invalidDraft(`${fieldName} is required.`);
    }

    return normalized;
}

function readOptionalString(value: JsonValue | undefined, fieldName: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw invalidDraft(`${fieldName} must be a string.`);
    }

    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized;
}

function readBoolean(value: JsonValue | undefined, fallback: boolean, fieldName: string): boolean {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "boolean") {
        throw invalidDraft(`${fieldName} must be a boolean.`);
    }

    return value;
}

function readNestedBoolean(
    recordValue: JsonValue | undefined,
    fieldName: string,
    fallback: boolean
): boolean {
    if (recordValue === undefined) {
        return fallback;
    }

    const record = asOptionalRecord(recordValue, "mcp");
    return readBoolean(record[fieldName], fallback, `mcp.${fieldName}`);
}

function readAllowTools(recordValue: JsonValue | undefined): string[] {
    if (recordValue === undefined) {
        return [...instanceCreateSchema.defaultAllowTools];
    }

    const record = asOptionalRecord(recordValue, "mcp");
    const value = record.allowTools;

    if (value === undefined) {
        return [...instanceCreateSchema.defaultAllowTools];
    }

    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw invalidDraft("mcp.allowTools must be a string array.");
    }

    return [...new Set(value.filter((entry): entry is string => typeof entry === "string").map((entry) => entry.trim()))];
}

function readLogs(value: JsonValue | undefined): ControlInstanceConfig["logs"] {
    const logs = value === undefined ? undefined : asOptionalRecord(value, "logs");

    return {
        eventBufferSize: readInteger(logs?.eventBufferSize, instanceCreateSchema.defaultEventBufferSize, "logs.eventBufferSize"),
        retentionDays: readInteger(logs?.retentionDays, instanceCreateSchema.defaultRetentionDays, "logs.retentionDays")
    };
}

function readSecurityMode(value: JsonValue | undefined): string {
    const security = value === undefined ? undefined : asOptionalRecord(value, "security");
    return readOptionalString(security?.mode, "security.mode") ?? instanceCreateSchema.defaultSecurityMode;
}

function readEnv(value: JsonValue | undefined): Record<string, string> | undefined {
    if (value === undefined) {
        return undefined;
    }

    const record = asOptionalRecord(value, "env");
    const entries = Object.entries(record);

    if (entries.length === 0) {
        return undefined;
    }

    const env: Record<string, string> = {};

    for (const [key, entryValue] of entries) {
        if (typeof entryValue !== "string") {
            throw invalidDraft(`env.${key} must be a string.`);
        }

        env[key] = entryValue;
    }

    return env;
}

function readInteger(value: JsonValue | undefined, fallback: number, fieldName: string): number {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw invalidDraft(`${fieldName} must be a non-negative integer.`);
    }

    return value;
}

function asOptionalRecord(value: JsonValue, fieldName: string): Record<string, JsonValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidDraft(`${fieldName} must be an object.`);
    }

    return value as Record<string, JsonValue>;
}

function invalidDraft(message: string) {
    return createError({
        code: errorCodes.authConfigInvalid,
        message,
        retryable: false
    });
}

function toConfigInvalidError(error: unknown) {
    return createError({
        code: errorCodes.authConfigInvalid,
        message: error instanceof Error ? error.message : String(error),
        retryable: false
    });
}

function toSummary(instance: ControlInstanceConfig): InstanceCreateSummary {
    return {
        ...(instance.container === undefined ? {} : { container: instance.container }),
        ...(instance.defaultWorkspace === undefined ? {} : { defaultWorkspace: instance.defaultWorkspace }),
        ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
        ...(instance.env === undefined ? {} : { env: instance.env }),
        ...(instance.host === undefined ? {} : { host: instance.host }),
        ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
        ...(instance.remoteCwd === undefined ? {} : { remoteCwd: instance.remoteCwd }),
        ...(instance.sshBinary === undefined ? {} : { sshBinary: instance.sshBinary }),
        ...(instance.workerBinaryPath === undefined ? {} : { workerBinaryPath: instance.workerBinaryPath }),
        enabled: instance.enabled,
        logs: {
            eventBufferSize: instance.logs?.eventBufferSize ?? instanceCreateSchema.defaultEventBufferSize,
            retentionDays: instance.logs?.retentionDays ?? instanceCreateSchema.defaultRetentionDays
        },
        mcp: {
            allowTools: [...instance.mcp.allowTools],
            enabled: instance.mcp.enabled,
            path: instance.mcp.path ?? `/${instance.name}/mcp`
        },
        name: instance.name,
        provider: instance.provider,
        security: {
            mode: instance.security?.mode ?? instanceCreateSchema.defaultSecurityMode
        }
    };
}

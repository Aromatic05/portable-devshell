import {
    createError,
    errorCodes,
    type InstanceContainerConfig,
    type InstanceContainerMountConfig,
    type InstanceContainerPresetSchema,
    type InstanceCreateResult,
    type InstanceCreateSchema,
    type InstanceCreateSummary,
    type JsonValue
} from "@portable-devshell/shared";
import type { McpHost, McpInstanceGateway, McpSshInstanceCreateInput } from "@portable-devshell/mcp";

import { InstanceConfigMapper } from "../instance/InstanceConfigMapper.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { McpEndpointConfigMapper } from "../mcp/McpEndpointConfigMapper.js";
import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type { ControlConfig, ControlInstanceConfig, ControlProviderKind } from "./config/ControlConfigTomlCodec.js";
import { ControlConfigValidator } from "./config/ControlConfigValidator.js";
import { instanceCreateProviders } from "./platform/ControlInstanceCreatePlatform.js";

const containerPresets = [
    { image: "archlinux:latest", preset: "arch" },
    { image: "ubuntu:24.04", preset: "ubuntu" },
    { image: "debian:stable", preset: "debian" },
    { image: "alpine:latest", preset: "alpine" }
] as const satisfies readonly InstanceContainerPresetSchema[];

const instanceCreateSchema: InstanceCreateSchema = {
    container: {
        defaultMode: "preset",
        modes: ["preset", "dockerfile", "compose", "existingImage", "existingStoppedContainer"],
        presets: containerPresets
    },
    defaultMcpCapabilities: ["read", "write", "execute"],
    defaultMcpGroups: ["file", "bash", "artifact", "tmux", "todo"],
    defaultEnabled: true,
    defaultMcpEnabled: true,
    defaultProvider: "local",
    defaultSecurityMode: "disabled",
    providers: ["local", "ssh", "docker", "podman", "reverse"]
};

export interface ControlInstanceCreateServiceOptions {
    configStore: ControlConfigStore;
    getConfig: () => ControlConfig;
    getMcpHost: () => McpHost | undefined;
    getMcpInstanceGateway?: () => McpInstanceGateway | undefined;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceConfigMapper;
    instanceRegistry: InstanceRegistry;
    platform?: NodeJS.Platform;
    mcpEndpointConfigMapper?: McpEndpointConfigMapper;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

export class ControlInstanceCreateService {
    readonly #configStore: ControlConfigStore;
    readonly #getConfig: () => ControlConfig;
    readonly #getMcpHost: () => McpHost | undefined;
    readonly #getMcpInstanceGateway: () => McpInstanceGateway | undefined;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceConfigMapper;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #mcpEndpointConfigMapper: McpEndpointConfigMapper;
    readonly #platform: NodeJS.Platform;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;

    constructor(options: ControlInstanceCreateServiceOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#getMcpHost = options.getMcpHost;
        this.#getMcpInstanceGateway = options.getMcpInstanceGateway ?? (() => undefined);
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceConfigMapper();
        this.#instanceRegistry = options.instanceRegistry;
        this.#mcpEndpointConfigMapper = options.mcpEndpointConfigMapper ?? new McpEndpointConfigMapper();
        this.#platform = options.platform ?? process.platform;
        this.#setConfig = options.setConfig;
        this.#validator = options.validator ?? new ControlConfigValidator();
    }

    getSchema(): InstanceCreateSchema {
        return {
            ...instanceCreateSchema,
            providers: instanceCreateProviders(this.#platform)
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

        const normalized: ControlInstanceConfig = {
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
                path: `/${input.name}/mcp`,
                tools: {
                    capabilities: source.mcp.tools.capabilities.filter((capability) => capability !== "manage"),
                    groups: source.mcp.tools.groups.filter((group) => group !== "instance")
                }
            },
            name: input.name,
            provider: "ssh",
            security: source.security === undefined ? undefined : { ...source.security },
            ssh: {
                command: buildMcpSshCommand(input)
            },
            workspace: input.workspace
        };

        return await this.#createNormalized(normalized);
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
            dockerBinary: readOptionalString(draft.dockerBinary, "dockerBinary"),
            enabled: readBoolean(draft.enabled, instanceCreateSchema.defaultEnabled, "enabled"),
            mcp: {
                enabled: readNestedBoolean(draft.mcp, "enabled", instanceCreateSchema.defaultMcpEnabled),
                path: `/${name}/mcp`,
                tools: readMcpTools(draft.mcp)
            },
            name,
            podmanBinary: readOptionalString(draft.podmanBinary, "podmanBinary"),
            provider,
            security: {
                mode: readSecurityMode(draft.security)
            },
            ssh: readSshDraft(draft.ssh),
            workspace: readRequiredString(draft.workspace, "workspace")
        };

        switch (provider) {
            case "local":
            case "reverse":
                break;
            case "ssh":
                normalized.ssh = {
                    command: readRequiredString(normalized.ssh?.command, "ssh.command")
                };
                break;
            case "docker":
            case "podman":
                normalized.container = readContainerDraft(draft.container, name);
                break;
        }

        return normalized;
    }
}


function buildMcpSshCommand(input: McpSshInstanceCreateInput): string {
    assertSafeSshAtom(input.host, "host");
    if (input.user !== undefined) {
        assertSafeSshAtom(input.user, "user");
    }

    const args = ["ssh"];
    if (input.port !== undefined) {
        args.push("-p", String(input.port));
    }
    if (input.identityFile !== undefined) {
        args.push("-i", input.identityFile);
    }
    args.push(input.user === undefined ? input.host : `${input.user}@${input.host}`);
    return args.map(quoteCommandArgument).join(" ");
}

function assertSafeSshAtom(value: string, fieldName: string): void {
    const hasUnsafeCharacter = [...value].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return /\s/u.test(character) || codePoint < 32 || codePoint === 127;
    });
    if (value.startsWith("-") || hasUnsafeCharacter) {
        throw invalidDraft(`${fieldName} must not contain whitespace, control characters, or begin with '-'.`);
    }
}

function quoteCommandArgument(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

function asDraftRecord(params: JsonValue | undefined): Record<string, JsonValue> {
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
        throw invalidDraft("instance create draft must be an object.");
    }

    return params as Record<string, JsonValue>;
}

function readProvider(value: JsonValue | undefined): ControlProviderKind {
    if (value === "local" || value === "ssh" || value === "docker" || value === "podman" || value === "reverse") {
        return value;
    }

    throw invalidDraft("provider must be one of local, ssh, docker, podman, reverse.");
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

function readMcpTools(recordValue: JsonValue | undefined): ControlInstanceConfig["mcp"]["tools"] {
    if (recordValue === undefined) {
        return {
            capabilities: [...instanceCreateSchema.defaultMcpCapabilities],
            groups: [...instanceCreateSchema.defaultMcpGroups]
        };
    }

    const mcp = asOptionalRecord(recordValue, "mcp");
    const toolsValue = mcp.tools;
    if (toolsValue === undefined) {
        return {
            capabilities: [...instanceCreateSchema.defaultMcpCapabilities],
            groups: [...instanceCreateSchema.defaultMcpGroups]
        };
    }

    const tools = asOptionalRecord(toolsValue, "mcp.tools");
    return {
        capabilities: readToolCapabilityArray(tools.capabilities, "mcp.tools.capabilities", instanceCreateSchema.defaultMcpCapabilities),
        groups: readStringArray(tools.groups, "mcp.tools.groups", instanceCreateSchema.defaultMcpGroups)
    };
}

function readToolCapabilityArray(
    value: JsonValue | undefined,
    fieldName: string,
    fallback: readonly ("read" | "write" | "execute" | "manage")[]
): Array<"read" | "write" | "execute" | "manage"> {
    return readStringArray(value, fieldName, fallback).map((entry) => {
        if (entry === "read" || entry === "write" || entry === "execute" || entry === "manage") {
            return entry;
        }
        throw invalidDraft(`${fieldName} must contain only read, write, execute, or manage.`);
    });
}

function readStringArray(value: JsonValue | undefined, fieldName: string, fallback: readonly string[]): string[] {
    if (value === undefined) {
        return [...fallback];
    }
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw invalidDraft(`${fieldName} must be a string array.`);
    }
    return [...new Set(value.map((entry) => String(entry).trim()))];
}

function readSecurityMode(value: JsonValue | undefined): string {
    const security = value === undefined ? undefined : asOptionalRecord(value, "security");
    return readOptionalString(security?.mode, "security.mode") ?? instanceCreateSchema.defaultSecurityMode;
}

function readSshDraft(value: JsonValue | undefined): ControlInstanceConfig["ssh"] {
    if (value === undefined) {
        return undefined;
    }

    const ssh = asOptionalRecord(value, "ssh");
    return {
        command: readOptionalString(ssh.command, "ssh.command")
    };
}

function readContainerDraft(value: JsonValue | undefined, instanceName: string): InstanceContainerConfig {
    const container = asRequiredRecord(value, "container");
    const mode = readContainerMode(readOptionalString(container.mode, "container.mode") ?? instanceCreateSchema.container.defaultMode);
    const defaultContainerName = `devshell-${instanceName}`;

    switch (mode) {
        case "preset": {
            const presetName = readRequiredString(container.preset, "container.preset");
            const preset = readPresetSchema(presetName);
            return {
                ...readManagedContainerDraft(container, "container", defaultContainerName),
                image: readOptionalString(container.image, "container.image") ?? preset.image,
                mode,
                preset: preset.preset
            };
        }
        case "dockerfile":
            return {
                ...readManagedContainerDraft(container, "container", defaultContainerName),
                build: readDockerfileBuildDraft(container.build, "container.build", instanceName),
                mode
            };
        case "compose":
            return {
                compose: readComposeDraft(container.compose, "container.compose"),
                mode
            };
        case "existingImage":
            return {
                ...readManagedContainerDraft(container, "container", defaultContainerName),
                image: readRequiredString(container.image, "container.image"),
                mode
            };
        case "existingStoppedContainer":
            return {
                adoptLifecycle: readOptionalBoolean(container.adoptLifecycle, "container.adoptLifecycle"),
                containerName: readRequiredString(container.containerName, "container.containerName"),
                mode
            };
    }
}

function readManagedContainerDraft(
    recordValue: JsonValue | undefined,
    fieldName: string,
    defaultContainerName: string
): {
    containerName: string;
    env?: Record<string, string>;
    mounts?: InstanceContainerMountConfig[];
    network?: string;
    user?: string;
} {
    const record = asRequiredRecord(recordValue, fieldName);

    return {
        containerName: readOptionalString(record.containerName, `${fieldName}.containerName`) ?? defaultContainerName,
        env: readOptionalStringRecord(record.env, `${fieldName}.env`),
        mounts: readOptionalMounts(record.mounts, `${fieldName}.mounts`),
        network: readOptionalString(record.network, `${fieldName}.network`),
        user: readOptionalString(record.user, `${fieldName}.user`)
    };
}

function readDockerfileBuildDraft(
    value: JsonValue | undefined,
    fieldName: string,
    instanceName: string
): NonNullable<Extract<InstanceContainerConfig, { mode: "dockerfile" }>["build"]> {
    const build = asRequiredRecord(value, fieldName);

    return {
        context: readRequiredString(build.context, `${fieldName}.context`),
        dockerfile: readOptionalString(build.dockerfile, `${fieldName}.dockerfile`),
        tag: readOptionalString(build.tag, `${fieldName}.tag`) ?? `devshell-${instanceName}:latest`
    };
}

function readComposeDraft(
    value: JsonValue | undefined,
    fieldName: string
): NonNullable<Extract<InstanceContainerConfig, { mode: "compose" }>["compose"]> {
    const compose = asRequiredRecord(value, fieldName);

    return {
        file: readRequiredString(compose.file, `${fieldName}.file`),
        projectName: readOptionalString(compose.projectName, `${fieldName}.projectName`),
        service: readRequiredString(compose.service, `${fieldName}.service`)
    };
}

function readOptionalMounts(value: JsonValue | undefined, fieldName: string): InstanceContainerMountConfig[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw invalidDraft(`${fieldName} must be an array.`);
    }

    return value.map((entry, index) => readMountDraft(entry, `${fieldName}[${index}]`));
}

function readMountDraft(value: JsonValue | undefined, fieldName: string): InstanceContainerMountConfig {
    const mount = asRequiredRecord(value, fieldName);
    const mode = readRequiredString(mount.mode, `${fieldName}.mode`);

    return {
        mode: mode === "ro" || mode === "rw" ? mode : invalidMountMode(mode, `${fieldName}.mode`),
        selinux: readOptionalMountSelinuxMode(mount.selinux, `${fieldName}.selinux`),
        source: readRequiredString(mount.source, `${fieldName}.source`),
        target: readRequiredString(mount.target, `${fieldName}.target`)
    };
}

function invalidMountMode(value: string, fieldName: string): never {
    throw invalidDraft(`${fieldName} must be one of ro, rw. Received: ${value}`);
}

function readOptionalMountSelinuxMode(
    value: JsonValue | undefined,
    fieldName: string
): InstanceContainerMountConfig["selinux"] {
    const normalized = readOptionalString(value, fieldName);

    if (normalized === undefined) {
        return undefined;
    }

    if (normalized === "private" || normalized === "shared") {
        return normalized;
    }

    throw invalidDraft(`${fieldName} must be one of private, shared.`);
}

function readOptionalStringRecord(value: JsonValue | undefined, fieldName: string): Record<string, string> | undefined {
    if (value === undefined) {
        return undefined;
    }

    const record = asRequiredRecord(value, fieldName);
    const result: Record<string, string> = {};

    for (const [key, entry] of Object.entries(record)) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
            throw invalidDraft(`${fieldName}.${key} must be a non-empty string.`);
        }

        result[key] = entry.trim();
    }

    return result;
}

function readOptionalBoolean(value: JsonValue | undefined, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (typeof value !== "boolean") {
        throw invalidDraft(`${fieldName} must be a boolean.`);
    }

    return value;
}

function readContainerMode(value: string): NonNullable<InstanceCreateSchema["container"]>["defaultMode"] {
    if (value === "preset" || value === "dockerfile" || value === "compose" || value === "existingImage" || value === "existingStoppedContainer") {
        return value;
    }

    throw invalidDraft("container.mode must be one of preset, dockerfile, compose, existingImage, existingStoppedContainer.");
}

function readPresetSchema(preset: string): InstanceContainerPresetSchema {
    const matched = containerPresets.find((entry) => entry.preset === preset);

    if (matched === undefined) {
        throw invalidDraft(`container.preset must be one of ${containerPresets.map((entry) => entry.preset).join(", ")}.`);
    }

    return matched;
}

function asRequiredRecord(value: JsonValue | undefined, fieldName: string): Record<string, JsonValue> {
    if (value === undefined) {
        throw invalidDraft(`${fieldName} is required.`);
    }

    return asOptionalRecord(value, fieldName);
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
        ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
        ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
        enabled: instance.enabled,
        mcp: {
            enabled: instance.mcp.enabled,
            path: instance.mcp.path ?? `/${instance.name}/mcp`,
            tools: {
                capabilities: [...instance.mcp.tools.capabilities],
                groups: [...instance.mcp.tools.groups]
            }
        },
        name: instance.name,
        provider: instance.provider,
        security: {
            mode: instance.security?.mode ?? instanceCreateSchema.defaultSecurityMode
        },
        ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
        ...(instance.workspace === undefined ? {} : { workspace: instance.workspace })
    };
}

import {
    createError,
    errorCodes,
    type ApprovalPolicy,
    type ApprovalPolicyDecision,
    type ApprovalPolicyMode,
    type ApprovalPolicySourceScope,
    type InstanceContainerComposeConfig,
    type InstanceContainerConfig,
    type InstanceContainerDockerfileConfig,
    type InstanceContainerExistingImageConfig,
    type InstanceContainerMountConfig,
    type InstanceContainerPresetConfig,
    type ToolCapability
} from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

export type ControlProviderKind = "docker" | "local" | "podman" | "ssh";
export type ControlMcpAuthMode = "none" | "oauth2" | "token";
export type ControlFileEditMode = "text" | "replace" | "patch" | "apply_patch";

export interface ControlInstanceLogsConfig {
    eventBufferSize?: number;
    retentionDays?: number;
}

export interface ControlToolSchedulerToolLimitConfig {
    maxRunning?: number;
    queueDepth?: number;
}

export interface ControlToolSchedulerConfig {
    maxRunning?: number;
    queueDepth?: number;
    queueTimeoutMs?: number;
    maxRunningPerSession?: number;
    queueDepthPerSession?: number;
    byTool?: Record<string, ControlToolSchedulerToolLimitConfig>;
}

export interface ControlInstanceFileEditConfig {
    mode?: ControlFileEditMode;
}

export interface ControlInstanceToolsConfig {
    fileEdit?: ControlInstanceFileEditConfig;
    scheduler?: ControlToolSchedulerConfig;
}

export interface ControlInstanceMcpConfig {
    enabled: boolean;
    path?: string;
    tools: {
        capabilities: ToolCapability[];
        groups: string[];
    };
}

export interface ControlInstanceSecurityConfig {
    mode?: string;
}

export interface ControlInstanceSshConfig {
    command?: string;
}

export interface ControlInstanceConfig {
    approvalPolicy?: ApprovalPolicy;
    container?: InstanceContainerConfig;
    dockerBinary?: string;
    enabled: boolean;
    env?: Record<string, string>;
    logs?: ControlInstanceLogsConfig;
    mcp: ControlInstanceMcpConfig;
    name: string;
    podmanBinary?: string;
    provider: ControlProviderKind;
    security?: ControlInstanceSecurityConfig;
    ssh?: ControlInstanceSshConfig;
    tools?: ControlInstanceToolsConfig;
    workspace?: string;
}

export interface ControlMcpOAuth2Config {
    audience?: string;
    documentationUrl?: string;
    issuer?: string;
    jwksUri?: string;
    requiredScopes: string[];
    resourceName: string;
}

export interface ControlGlobalConfig {
    control: {
        logLevel: string;
    };
    mcp: {
        auth: {
            mode: ControlMcpAuthMode;
            oauth2?: ControlMcpOAuth2Config;
        };
        enabled: boolean;
        listenHost: string;
        listenPort: number;
        publicBaseUrl?: string;
    };
    version: number;
}

export interface ControlConfig extends ControlGlobalConfig {
    instances: ControlInstanceConfig[];
}

type TomlRecord = TomlTableWithoutBigInt;

export class ControlConfigTomlCodec {
    decode(source: string): ControlGlobalConfig {
        try {
            return this.#fromTomlDocument(parse(source) as TomlTableWithoutBigInt);
        } catch (error) {
            if (isStructuredConfigError(error)) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            const fieldPath = readFieldPath(message);
            throw createError({
                code: errorCodes.controlConfigParseFailed,
                cause: error,
                details: {
                    ...(fieldPath === undefined ? {} : { fieldPath }),
                    phase: "decode"
                },
                message,
                retryable: false
            });
        }
    }

    encode(config: ControlConfig): string {
        return stringify({
            version: config.version,
            control: {
                logLevel: config.control.logLevel
            },
            mcp: {
                enabled: config.mcp.enabled,
                listenHost: config.mcp.listenHost,
                listenPort: config.mcp.listenPort,
                ...(config.mcp.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.mcp.publicBaseUrl }),
                auth: {
                    mode: config.mcp.auth.mode,
                    ...(config.mcp.auth.oauth2 === undefined ? {} : { oauth2: withoutUndefined(config.mcp.auth.oauth2) })
                }
            }
        });
    }

    #fromTomlDocument(document: TomlRecord): ControlGlobalConfig {
        const control = asRecord(document.control, "control");
        const mcp = asRecord(document.mcp, "mcp");
        const auth = asRecord(mcp.auth, "mcp.auth");
        if (document.instances !== undefined) {
            throw createError({
                code: errorCodes.controlConfigValidationFailed,
                details: {
                    fieldPath: "instances",
                    phase: "decode"
                },
                message: "Legacy [[instances]] entries are not supported. Move them into ~/.devshell/control/instances/*.toml.",
                retryable: false
            });
        }

        return {
            control: {
                logLevel: asString(control.logLevel, "control.logLevel")
            },
            mcp: {
                auth: {
                    mode: asAuthMode(asString(auth.mode, "mcp.auth.mode")),
                    oauth2: auth.oauth2 === undefined ? undefined : parseOauth2Config(auth.oauth2)
                },
                enabled: asBoolean(mcp.enabled, "mcp.enabled"),
                listenHost: asString(mcp.listenHost, "mcp.listenHost"),
                listenPort: asInteger(mcp.listenPort, "mcp.listenPort"),
                publicBaseUrl: asOptionalString(mcp.publicBaseUrl, "mcp.publicBaseUrl")
            },
            version: asInteger(document.version, "version")
        };
    }
}

function parseOauth2Config(value: unknown): ControlMcpOAuth2Config {
    const oauth2 = asRecord(value, "mcp.auth.oauth2");

    return {
        audience: asOptionalString(oauth2.audience, "mcp.auth.oauth2.audience"),
        documentationUrl: asOptionalString(oauth2.documentationUrl, "mcp.auth.oauth2.documentationUrl"),
        issuer: asOptionalString(oauth2.issuer, "mcp.auth.oauth2.issuer"),
        jwksUri: asOptionalString(oauth2.jwksUri, "mcp.auth.oauth2.jwksUri"),
        requiredScopes: oauth2.requiredScopes === undefined ? [] : asStringArray(oauth2.requiredScopes, "mcp.auth.oauth2.requiredScopes"),
        resourceName: asString(oauth2.resourceName, "mcp.auth.oauth2.resourceName")
    };
}

export class ControlInstanceTomlCodec {
    decode(source: string): ControlInstanceConfig {
        try {
            return parseInstanceDocument(parse(source) as TomlTableWithoutBigInt);
        } catch (error) {
            if (isStructuredConfigError(error)) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            const fieldPath = readFieldPath(message);
            throw createError({
                code: errorCodes.controlConfigParseFailed,
                cause: error,
                details: {
                    ...(fieldPath === undefined ? {} : { fieldPath }),
                    phase: "decode"
                },
                message,
                retryable: false
            });
        }
    }

    encode(instance: ControlInstanceConfig): string {
        return stringify({
            version: 2,
            name: instance.name,
            enabled: instance.enabled,
            provider: instance.provider,
            ...(instance.workspace === undefined ? {} : { workspace: instance.workspace }),
            ...(instance.container === undefined ? {} : { container: encodeContainer(instance.container) }),
            ...(instance.ssh === undefined ? {} : { ssh: withoutUndefined(instance.ssh) }),
            ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
            ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
            ...(instance.env === undefined || Object.keys(instance.env).length === 0 ? {} : { env: instance.env }),
            mcp: {
                enabled: instance.mcp.enabled,
                ...(instance.mcp.path === undefined ? {} : { path: instance.mcp.path }),
                tools: {
                    capabilities: [...instance.mcp.tools.capabilities],
                    groups: [...instance.mcp.tools.groups]
                }
            },
            ...(instance.logs === undefined ? {} : { logs: withoutUndefined(instance.logs) }),
            ...(instance.approvalPolicy === undefined ? {} : { approvalPolicy: encodeApprovalPolicy(instance.approvalPolicy) }),
            ...(instance.tools === undefined ? {} : { tools: encodeToolsConfig(instance.tools) }),
            ...(instance.security === undefined ? {} : { security: withoutUndefined(instance.security) })
        });
    }
}

function parseInstanceDocument(document: TomlRecord): ControlInstanceConfig {
    const env = asOptionalRecord(document.env, "env");
    const mcp = asRecord(document.mcp, "mcp");
    if (mcp.allowTools !== undefined) {
        throw new Error("mcp.allowTools is no longer supported; use mcp.tools.groups and mcp.tools.capabilities");
    }
    const mcpTools = asRecord(mcp.tools, "mcp.tools");
    const logs = asOptionalRecord(document.logs, "logs");
    const approvalPolicy = asOptionalRecord(document.approvalPolicy, "approvalPolicy");
    const security = asOptionalRecord(document.security, "security");
    const ssh = asOptionalRecord(document.ssh, "ssh");
    const container = asOptionalRecord(document.container, "container");
    const tools = asOptionalRecord(document.tools, "tools");

    if (document.workerBinaryPath !== undefined) {
        throw new Error("workerBinaryPath is not supported");
    }

    if (document.host !== undefined) {
        throw new Error("host is not supported; use ssh.command");
    }

    if (document.remoteCwd !== undefined) {
        throw new Error("remoteCwd is not supported; use workspace");
    }

    if (document.sshBinary !== undefined) {
        throw new Error("sshBinary is not supported; use ssh.command");
    }

    if (asInteger(document.version, "version") !== 2) {
        throw new Error("version must be 2");
    }

    return {
        approvalPolicy: approvalPolicy === undefined ? undefined : parseApprovalPolicy(approvalPolicy),
        container: container === undefined ? undefined : parseContainerConfig(container),
        dockerBinary: asOptionalString(document.dockerBinary, "dockerBinary"),
        enabled: asBoolean(document.enabled, "enabled"),
        env: env === undefined ? undefined : asStringRecord(env, "env"),
        logs:
            logs === undefined
                ? undefined
                : {
                      eventBufferSize: asOptionalInteger(logs.eventBufferSize, "logs.eventBufferSize"),
                      retentionDays: asOptionalInteger(logs.retentionDays, "logs.retentionDays")
                  },
        mcp: {
            enabled: asBoolean(mcp.enabled, "mcp.enabled"),
            path: asOptionalString(mcp.path, "mcp.path"),
            tools: {
                capabilities: asToolCapabilityArray(mcpTools.capabilities, "mcp.tools.capabilities"),
                groups: asStringArray(mcpTools.groups, "mcp.tools.groups")
            }
        },
        name: asString(document.name, "name"),
        podmanBinary: asOptionalString(document.podmanBinary, "podmanBinary"),
        provider: asProviderKind(asString(document.provider, "provider")),
        security: security === undefined ? undefined : { mode: asOptionalString(security.mode, "security.mode") },
        ssh: ssh === undefined ? undefined : { command: asOptionalString(ssh.command, "ssh.command") },
        tools: tools === undefined ? undefined : parseToolsConfig(tools),
        workspace: asOptionalString(document.workspace, "workspace")
    };
}

function encodeToolsConfig(tools: ControlInstanceToolsConfig): TomlRecord {
    return {
        ...(tools.fileEdit === undefined ? {} : { fileEdit: withoutUndefined(tools.fileEdit) }),
        ...(tools.scheduler === undefined ? {} : { scheduler: encodeToolSchedulerConfig(tools.scheduler) })
    };
}

function encodeToolSchedulerConfig(scheduler: ControlToolSchedulerConfig): TomlRecord {
    return {
        ...withoutUndefined({
            maxRunning: scheduler.maxRunning,
            queueDepth: scheduler.queueDepth,
            queueTimeoutMs: scheduler.queueTimeoutMs,
            maxRunningPerSession: scheduler.maxRunningPerSession,
            queueDepthPerSession: scheduler.queueDepthPerSession
        }),
        ...(scheduler.byTool === undefined ? {} : { byTool: encodeToolSchedulerByTool(scheduler.byTool) })
    };
}

function encodeToolSchedulerByTool(byTool: Record<string, ControlToolSchedulerToolLimitConfig>): TomlRecord {
    return Object.fromEntries(
        Object.entries(byTool).map(([toolName, limits]) => [
            toolName,
            withoutUndefined({
                maxRunning: limits.maxRunning,
                queueDepth: limits.queueDepth
            })
        ])
    ) as TomlRecord;
}

function parseToolsConfig(tools: TomlRecord): ControlInstanceToolsConfig {
    const fileEdit = asOptionalRecord(tools.fileEdit, "tools.fileEdit");
    const scheduler = asOptionalRecord(tools.scheduler, "tools.scheduler");
    return {
        fileEdit:
            fileEdit === undefined
                ? undefined
                : { mode: asOptionalFileEditMode(fileEdit.mode, "tools.fileEdit.mode") },
        scheduler: scheduler === undefined ? undefined : parseToolSchedulerConfig(scheduler)
    };
}

function parseToolSchedulerConfig(scheduler: TomlRecord): ControlToolSchedulerConfig {
    const byTool = asOptionalRecord(scheduler.byTool, "tools.scheduler.byTool");
    return {
        maxRunning: asOptionalInteger(scheduler.maxRunning, "tools.scheduler.maxRunning"),
        queueDepth: asOptionalInteger(scheduler.queueDepth, "tools.scheduler.queueDepth"),
        queueTimeoutMs: asOptionalInteger(scheduler.queueTimeoutMs, "tools.scheduler.queueTimeoutMs"),
        maxRunningPerSession: asOptionalInteger(scheduler.maxRunningPerSession, "tools.scheduler.maxRunningPerSession"),
        queueDepthPerSession: asOptionalInteger(scheduler.queueDepthPerSession, "tools.scheduler.queueDepthPerSession"),
        byTool: byTool === undefined ? undefined : parseToolSchedulerByTool(byTool)
    };
}

function parseToolSchedulerByTool(byTool: TomlRecord): Record<string, ControlToolSchedulerToolLimitConfig> {
    return Object.fromEntries(
        Object.entries(byTool).map(([toolName, value]) => {
            const toolLimit = asRecord(value, `tools.scheduler.byTool.${toolName}`);
            return [
                toolName,
                {
                    maxRunning: asOptionalInteger(toolLimit.maxRunning, `tools.scheduler.byTool.${toolName}.maxRunning`),
                    queueDepth: asOptionalInteger(toolLimit.queueDepth, `tools.scheduler.byTool.${toolName}.queueDepth`)
                }
            ];
        })
    );
}

function encodeApprovalPolicy(policy: ApprovalPolicy): TomlRecord {
    return {
        mode: policy.mode,
        ...(policy.rules === undefined || policy.rules.length === 0
            ? {}
            : {
                  rules: policy.rules.map((rule) => ({
                      decision: rule.decision,
                      match: rule.match,
                      source: rule.source,
                      ...(rule.toolName === undefined ? {} : { toolName: rule.toolName })
                  }))
              })
    };
}

function parseApprovalPolicy(policy: TomlRecord): ApprovalPolicy {
    return {
        mode: asApprovalPolicyMode(asString(policy.mode, "approvalPolicy.mode")),
        rules: policy.rules === undefined ? undefined : parseApprovalPolicyRules(policy.rules, "approvalPolicy.rules")
    };
}

function parseApprovalPolicyRules(value: unknown, fieldName: string): ApprovalPolicy["rules"] {
    const rules = asOptionalArray(value, fieldName);

    return rules?.map((entry, index) => {
        const record = asRecord(entry, `${fieldName}[${index}]`);

        return {
            decision: asApprovalPolicyDecision(
                asString(record.decision, `${fieldName}[${index}].decision`)
            ),
            match: asApprovalPolicyMatch(asString(record.match, `${fieldName}[${index}].match`)),
            source: asApprovalPolicySourceScope(
                asString(record.source, `${fieldName}[${index}].source`)
            ),
            toolName: asOptionalString(record.toolName, `${fieldName}[${index}].toolName`)
        };
    });
}

function encodeContainer(container: InstanceContainerConfig): TomlRecord {
    switch (container.mode) {
        case "preset":
            return {
                ...encodeManagedContainerFields(container),
                image: container.image,
                mode: container.mode,
                preset: container.preset
            };
        case "dockerfile":
            return {
                ...encodeManagedContainerFields(container),
                build: withoutUndefined(container.build),
                mode: container.mode
            };
        case "compose":
            return {
                compose: withoutUndefined(container.compose),
                mode: container.mode,
            };
        case "existingImage":
            return {
                ...encodeManagedContainerFields(container),
                image: container.image,
                mode: container.mode
            };
        case "existingStoppedContainer":
            return {
                ...(container.adoptLifecycle === undefined ? {} : { adoptLifecycle: container.adoptLifecycle }),
                containerName: container.containerName,
                mode: container.mode
            };
        default:
            return assertNever(container);
    }
}

function parseContainerConfig(container: TomlRecord): InstanceContainerConfig {
    const mode = asString(container.mode, "container.mode");

    switch (mode) {
        case "preset":
            return {
                ...parseManagedContainerFields(container, "container"),
                image: asString((container as TomlRecord).image, "container.image"),
                mode,
                preset: asString((container as TomlRecord).preset, "container.preset")
            };
        case "dockerfile":
            return {
                ...parseManagedContainerFields(container, "container"),
                build: parseDockerfileBuildConfig(asRecord((container as TomlRecord).build, "container.build"), "container.build"),
                mode
            };
        case "compose":
            return {
                compose: parseComposeConfig(asRecord((container as TomlRecord).compose, "container.compose"), "container.compose"),
                mode,
            };
        case "existingImage":
            return {
                ...parseManagedContainerFields(container, "container"),
                image: asString((container as TomlRecord).image, "container.image"),
                mode
            };
        case "existingStoppedContainer":
            return {
                adoptLifecycle: asOptionalBoolean(
                    (container as TomlRecord).adoptLifecycle,
                    "container.adoptLifecycle"
                ),
                containerName: asString(
                    (container as TomlRecord).containerName,
                    "container.containerName"
                ),
                mode
            };
        default:
            throw new Error("container.mode must be one of preset, dockerfile, compose, existingImage, existingStoppedContainer");
    }
}

function encodeManagedContainerFields(
    container: InstanceContainerPresetConfig | InstanceContainerDockerfileConfig | InstanceContainerExistingImageConfig
): TomlRecord {
    return {
        containerName: container.containerName,
        ...(container.env === undefined || Object.keys(container.env).length === 0 ? {} : { env: container.env }),
        ...(container.mounts === undefined || container.mounts.length === 0 ? {} : { mounts: container.mounts.map(encodeMount) }),
        ...(container.network === undefined ? {} : { network: container.network }),
        ...(container.user === undefined ? {} : { user: container.user })
    };
}

function encodeMount(mount: InstanceContainerMountConfig): TomlRecord {
    return {
        mode: mount.mode,
        ...(mount.selinux === undefined ? {} : { selinux: mount.selinux }),
        source: mount.source,
        target: mount.target
    };
}

function parseManagedContainerFields(
    container: TomlRecord,
    fieldName: string
): Pick<InstanceContainerPresetConfig, "containerName" | "env" | "mounts" | "network" | "user"> {
    const env = asOptionalRecord(container.env, `${fieldName}.env`);
    const mounts = asOptionalArray(container.mounts, `${fieldName}.mounts`);

    return {
        containerName: asString(container.containerName, `${fieldName}.containerName`),
        env: env === undefined ? undefined : asStringRecord(env, `${fieldName}.env`),
        mounts: mounts === undefined ? undefined : mounts.map((entry, index) => parseMount(entry, `${fieldName}.mounts[${index}]`)),
        network: asOptionalString(container.network, `${fieldName}.network`),
        user: asOptionalString(container.user, `${fieldName}.user`)
    };
}

function parseDockerfileBuildConfig(container: TomlRecord, fieldName: string): InstanceContainerDockerfileConfig["build"] {
    return {
        context: asString(container.context, `${fieldName}.context`),
        dockerfile: asOptionalString(container.dockerfile, `${fieldName}.dockerfile`),
        tag: asOptionalString(container.tag, `${fieldName}.tag`)
    };
}

function parseComposeConfig(container: TomlRecord, fieldName: string): InstanceContainerComposeConfig["compose"] {
    return {
        file: asString(container.file, `${fieldName}.file`),
        projectName: asOptionalString(container.projectName, `${fieldName}.projectName`),
        service: asString(container.service, `${fieldName}.service`)
    };
}

function parseMount(mount: unknown, fieldName: string): InstanceContainerMountConfig {
    const record = asRecord(mount, fieldName);

    return {
        mode: asMountMode(asString(record.mode, `${fieldName}.mode`)),
        selinux: asOptionalMountSelinuxMode(record.selinux, `${fieldName}.selinux`),
        source: asString(record.source, `${fieldName}.source`),
        target: asString(record.target, `${fieldName}.target`)
    };
}

function withoutUndefined<T extends object>(record: T): Partial<T> {
    return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is TomlRecord {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown, fieldName: string): TomlRecord {
    if (!isRecord(value)) {
        throw new Error(`${fieldName} must be a table`);
    }

    return value;
}

function asOptionalRecord(value: unknown, fieldName: string): TomlRecord | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asRecord(value, fieldName);
}

function asString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function asOptionalString(value: unknown, fieldName: string): string | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asString(value, fieldName);
}

function asBoolean(value: unknown, fieldName: string): boolean {
    if (typeof value !== "boolean") {
        throw new Error(`${fieldName} must be a boolean`);
    }

    return value;
}

function asOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asBoolean(value, fieldName);
}

function asInteger(value: unknown, fieldName: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new Error(`${fieldName} must be an integer`);
    }

    return value;
}

function asOptionalInteger(value: unknown, fieldName: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    return asInteger(value, fieldName);
}

function asStringArray(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${fieldName} must be a string array`);
    }

    return [...value];
}

function asToolCapabilityArray(value: unknown, fieldName: string): ToolCapability[] {
    return asStringArray(value, fieldName).map((entry) => {
        if (entry === "read" || entry === "write" || entry === "execute" || entry === "manage") {
            return entry;
        }
        throw new Error(`${fieldName} must contain only read, write, execute, or manage`);
    });
}

function asOptionalArray(value: unknown, fieldName: string): unknown[] | undefined {
    if (value === undefined) {
        return undefined;
    }

    if (!Array.isArray(value)) {
        throw new Error(`${fieldName} must be an array`);
    }

    return [...value];
}

function asStringRecord(value: TomlRecord, fieldName: string): Record<string, string> {
    const entries = Object.entries(value);
    const record: Record<string, string> = {};

    for (const [key, entryValue] of entries) {
        if (typeof entryValue !== "string") {
            throw new Error(`${fieldName}.${key} must be a string`);
        }

        record[key] = entryValue;
    }

    return record;
}

function asProviderKind(value: string): ControlProviderKind {
    if (value === "local" || value === "ssh" || value === "docker" || value === "podman") {
        return value;
    }

    throw new Error(`unsupported provider: ${value}`);
}

function asOptionalFileEditMode(value: unknown, fieldName: string): ControlFileEditMode | undefined {
    if (value === undefined) {
        return undefined;
    }
    const mode = asString(value, fieldName);
    if (mode === "text" || mode === "replace" || mode === "patch" || mode === "apply_patch") {
        return mode;
    }
    throw new Error(`${fieldName} must be one of text, replace, patch, apply_patch`);
}

function asAuthMode(value: string): ControlMcpAuthMode {
    if (value === "none" || value === "token" || value === "oauth2") {
        return value;
    }

    throw new Error(`unsupported mcp.auth.mode: ${value}`);
}

function asApprovalPolicyMode(value: string): ApprovalPolicyMode {
    if (value === "disabled" || value === "allow" || value === "ask" || value === "deny") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.mode: ${value}`);
}

function asApprovalPolicyDecision(value: string): ApprovalPolicyDecision {
    if (value === "allow" || value === "ask" || value === "deny") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].decision: ${value}`);
}

function asApprovalPolicyMatch(value: string): "exact" {
    if (value === "exact") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].match: ${value}`);
}

function asApprovalPolicySourceScope(value: string): ApprovalPolicySourceScope {
    if (value === "all" || value === "cli" || value === "tui" || value === "mcp") {
        return value;
    }

    throw new Error(`unsupported approvalPolicy.rules[].source: ${value}`);
}

function asMountMode(value: string): InstanceContainerMountConfig["mode"] {
    if (value === "ro" || value === "rw") {
        return value;
    }

    throw new Error(`unsupported mount mode: ${value}`);
}

function asOptionalMountSelinuxMode(value: unknown, fieldName: string): InstanceContainerMountConfig["selinux"] {
    if (value === undefined) {
        return undefined;
    }

    const normalized = asString(value, fieldName);
    if (normalized === "private" || normalized === "shared") {
        return normalized;
    }

    throw new Error(`${fieldName} must be one of private, shared`);
}

function isStructuredConfigError(error: unknown): error is { code: string } {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function readFieldPath(message: string): string | undefined {
    const match = message.match(/^([A-Za-z0-9_.[\]]+)\s+/u);
    return match?.[1];
}

function assertNever(value: never): never {
    throw new Error(`unsupported container mode: ${String(value)}`);
}

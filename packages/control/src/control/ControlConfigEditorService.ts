import {
    asWorkspacePath,
    createError,
    errorCodes,
    type ApprovalPolicy,
    type JsonValue
} from "@portable-devshell/shared";

import { InstanceConfigMapper } from "../instance/InstanceConfigMapper.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { ControlConfigStore } from "./config/ControlConfigStore.js";
import type {
    ControlConfig,
    ControlGlobalConfig,
    ControlInstanceConfig,
    ControlMcpAuthMode
} from "./config/ControlConfigTomlCodec.js";
import { ControlConfigValidator } from "./config/ControlConfigValidator.js";

interface ControlConfigEditorServiceOptions {
    configStore: ControlConfigStore;
    getConfig: () => ControlConfig;
    homeDirectory?: string;
    instanceConfigMapper?: InstanceConfigMapper;
    instanceRegistry: InstanceRegistry;
    setConfig: (config: ControlConfig) => void;
    validator?: ControlConfigValidator;
}

interface ApplyChange {
    kind: "instance.deleted" | "instance.disabled" | "instance.enabled" | "instance.updated" | "mcp.updated";
    target: string;
}

interface ApplyResult {
    affectedInstances: string[];
    affectedMcpEndpoints: string[];
    appliedChanges: ApplyChange[];
    reloadRequired: boolean;
    restartControlRequired: boolean;
}

const emptyApplyResult = (): ApplyResult => ({
    affectedInstances: [],
    affectedMcpEndpoints: [],
    appliedChanges: [],
    reloadRequired: false,
    restartControlRequired: false
});

export class ControlConfigEditorService {
    readonly #configStore: ControlConfigStore;
    readonly #getConfig: () => ControlConfig;
    readonly #homeDirectory?: string;
    readonly #instanceConfigMapper: InstanceConfigMapper;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #setConfig: (config: ControlConfig) => void;
    readonly #validator: ControlConfigValidator;
    #lastApplyResult: ApplyResult = emptyApplyResult();

    constructor(options: ControlConfigEditorServiceOptions) {
        this.#configStore = options.configStore;
        this.#getConfig = options.getConfig;
        this.#homeDirectory = options.homeDirectory;
        this.#instanceConfigMapper = options.instanceConfigMapper ?? new InstanceConfigMapper();
        this.#instanceRegistry = options.instanceRegistry;
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
        await this.#persistConfig(nextConfig);
        const descriptor = this.#instanceRegistry.get(instance.name);

        if (descriptor === undefined) {
            if (instance.enabled) {
                this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
            }
        } else if (requiresWorkerRebuild(existing, instance)) {
            this.#assertInstanceStopped(instance.name, "update");
            this.#instanceRegistry.add(this.#instanceConfigMapper.map(instance));
        } else {
            descriptor.allowTools = [...instance.mcp.allowTools];
            descriptor.enabled = instance.enabled;
            descriptor.mcpEnabled = instance.mcp.enabled;
            descriptor.mcpPath = instance.mcp.path ?? `/${instance.name}/mcp`;
            descriptor.worker.reconfigure(toWorkerReconfigureInput(instance));
        }
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

        this.#rememberApplyResult(
            buildApplyResult(currentConfig, nextConfig, [{ kind: enabled ? "instance.enabled" : "instance.disabled", target: instanceName }])
        );
        return this.getConfigView();
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

    #rememberApplyResult(result: ApplyResult): void {
        this.#lastApplyResult = mergeApplyResults(this.#lastApplyResult, result);
    }
}

function toConfigView(config: ControlConfig): Record<string, JsonValue> {
    return {
        control: {
            logLevel: config.control.logLevel
        },
        instances: config.instances.map((instance) => ({
            ...(instance.approvalPolicy === undefined
                ? {}
                : {
                      approvalPolicy: cloneApprovalPolicy(instance.approvalPolicy)
                  }),
            ...(instance.container === undefined ? {} : { container: instance.container }),
            ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
            enabled: instance.enabled,
            ...(instance.env === undefined ? {} : { env: { ...instance.env } }),
            ...(instance.logs === undefined ? {} : { logs: { ...instance.logs } }),
            ...(instance.tools === undefined ? {} : { tools: cloneToolsConfig(instance.tools) }),
            mcp: {
                allowTools: [...instance.mcp.allowTools],
                enabled: instance.mcp.enabled,
                ...(instance.mcp.path === undefined ? {} : { path: instance.mcp.path })
            },
            name: instance.name,
            ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
            provider: instance.provider,
            security: {
                effectiveMode: resolveSecurityMode(instance.security?.mode),
                mode: resolveSecurityMode(instance.security?.mode)
            },
            ...(instance.ssh === undefined ? {} : { ssh: { ...instance.ssh } }),
            ...(instance.workspace === undefined ? {} : { workspace: instance.workspace })
        })),
        mcp: {
            auth: {
                mode: config.mcp.auth.mode,
                ...(config.mcp.auth.oauth2 === undefined ? {} : { oauth2: { ...config.mcp.auth.oauth2 } })
            },
            enabled: config.mcp.enabled,
            listenHost: config.mcp.listenHost,
            listenPort: config.mcp.listenPort,
            ...(config.mcp.publicBaseUrl === undefined ? {} : { publicBaseUrl: config.mcp.publicBaseUrl })
        },
        version: config.version
    } as unknown as Record<string, JsonValue>;
}

function buildApplyResult(previous: ControlConfig, next: ControlConfig, appliedChanges: ApplyChange[]): ApplyResult {
    const affectedInstances = new Set<string>();
    const affectedMcpEndpoints = new Set<string>();
    let restartControlRequired = false;

    const previousInstances = new Map(previous.instances.map((instance) => [instance.name, instance] as const));
    const nextInstances = new Map(next.instances.map((instance) => [instance.name, instance] as const));
    const instanceNames = new Set([...previousInstances.keys(), ...nextInstances.keys()]);

    for (const instanceName of instanceNames) {
        const previousInstance = previousInstances.get(instanceName);
        const nextInstance = nextInstances.get(instanceName);

        if (stableStringify(previousInstance) === stableStringify(nextInstance)) {
            continue;
        }

        affectedInstances.add(instanceName);
        if (hasMcpEndpointChange(previousInstance, nextInstance)) {
            affectedMcpEndpoints.add(nextInstance?.mcp.path ?? previousInstance?.mcp.path ?? `/${instanceName}/mcp`);
            restartControlRequired = true;
        }
    }

    if (stableStringify(previous.mcp) !== stableStringify(next.mcp)) {
        restartControlRequired = true;
        affectedMcpEndpoints.add("mcp");
    }

    return {
        affectedInstances: [...affectedInstances].sort((left, right) => left.localeCompare(right)),
        affectedMcpEndpoints: [...affectedMcpEndpoints].sort((left, right) => left.localeCompare(right)),
        appliedChanges,
        reloadRequired: affectedInstances.size > 0,
        restartControlRequired
    };
}

function mergeApplyResults(previous: ApplyResult, next: ApplyResult): ApplyResult {
    return {
        affectedInstances: [...new Set([...previous.affectedInstances, ...next.affectedInstances])].sort((left, right) =>
            left.localeCompare(right)
        ),
        affectedMcpEndpoints: [...new Set([...previous.affectedMcpEndpoints, ...next.affectedMcpEndpoints])].sort((left, right) =>
            left.localeCompare(right)
        ),
        appliedChanges: [...previous.appliedChanges, ...next.appliedChanges],
        reloadRequired: previous.reloadRequired || next.reloadRequired,
        restartControlRequired: previous.restartControlRequired || next.restartControlRequired
    };
}

function toWorkerReconfigureInput(instance: ControlInstanceConfig): {
    approvalPolicy?: ApprovalPolicy;
    defaultWorkspace?: ReturnType<typeof asWorkspacePath>;
    effectiveSecurityMode: "disabled" | "workspace";
    env?: NodeJS.ProcessEnv;
} {
    const effectiveSecurityMode = resolveSecurityMode(instance.security?.mode);

    return {
        approvalPolicy: instance.approvalPolicy,
        defaultWorkspace: instance.workspace === undefined ? undefined : asWorkspacePath(instance.workspace),
        effectiveSecurityMode,
        env: {
            ...instance.env,
            DEVSHELL_WORKER_INTERNAL_SECURITY_MODE: effectiveSecurityMode,
            DEVSHELL_WORKER_SECURITY_MODE: effectiveSecurityMode
        }
    };
}

function requiresWorkerRebuild(previous: ControlInstanceConfig, next: ControlInstanceConfig): boolean {
    return [
        previous.provider !== next.provider,
        stableStringify(previous.ssh) !== stableStringify(next.ssh),
        stableStringify(previous.container) !== stableStringify(next.container),
        previous.dockerBinary !== next.dockerBinary,
        previous.podmanBinary !== next.podmanBinary,
        stableStringify(previous.logs) !== stableStringify(next.logs),
        stableStringify(previous.tools) !== stableStringify(next.tools)
    ].some(Boolean);
}

function hasMcpEndpointChange(
    previousInstance: ControlInstanceConfig | undefined,
    nextInstance: ControlInstanceConfig | undefined
): boolean {
    return stableStringify(previousInstance?.mcp) !== stableStringify(nextInstance?.mcp);
}

function stableStringify(value: unknown): string {
    return JSON.stringify(value);
}

function readConfigDraft(params: JsonValue | undefined, currentConfig: ControlConfig): ControlConfig {
    const draft = readRecord(params, "control.validateConfigDraft");

    return {
        control: readControlConfig(draft.control, currentConfig.control),
        instances: readInstances(draft.instances, currentConfig),
        mcp: readMcpConfig(draft.mcp, currentConfig),
        version: readVersion(draft.version, currentConfig.version)
    };
}

function readInstanceConfig(params: JsonValue | undefined, currentConfig: ControlConfig): ControlInstanceConfig {
    return readSingleInstanceConfig(params, "control.updateInstanceConfig", currentConfig);
}

function readInstances(value: JsonValue | undefined, currentConfig: ControlConfig): ControlInstanceConfig[] {
    if (value === undefined) {
        return currentConfig.instances.map((instance) => cloneInstanceConfig(instance));
    }

    if (!Array.isArray(value)) {
        throw invalidConfig("instances must be an array.");
    }

    return value.map((entry) => readSingleInstanceConfig(entry, "instances[]", currentConfig));
}

function readSingleInstanceConfig(
    value: JsonValue | undefined,
    fieldName: string,
    currentConfig: ControlConfig
): ControlInstanceConfig {
    const instance = readRecord(value, fieldName);
    const name = readRequiredString(instance.name, `${fieldName}.name`);
    const current = currentConfig.instances.find((entry) => entry.name === name);

    return {
        approvalPolicy: readApprovalPolicy(instance.approvalPolicy, current?.approvalPolicy),
        container: readRawValue(instance.container, current?.container),
        dockerBinary: readOptionalString(instance.dockerBinary, `${fieldName}.dockerBinary`),
        enabled: readBoolean(instance.enabled, current?.enabled ?? true, `${fieldName}.enabled`),
        env: readStringRecord(instance.env, `${fieldName}.env`, current?.env),
        logs: readLogsConfig(instance.logs, current?.logs, `${fieldName}.logs`),
        mcp: readInstanceMcpConfig(instance.mcp, current?.mcp, name, `${fieldName}.mcp`),
        name,
        podmanBinary: readOptionalString(instance.podmanBinary, `${fieldName}.podmanBinary`),
        provider: readProvider(instance.provider, `${fieldName}.provider`),
        security: {
            mode: resolveSecurityMode(readSecurityMode(instance.security, current?.security?.mode, `${fieldName}.security`))
        },
        ssh: readSshConfig(instance.ssh, current?.ssh, `${fieldName}.ssh`),
        tools: readToolsConfig(instance.tools, current?.tools, `${fieldName}.tools`),
        workspace: readOptionalString(instance.workspace, `${fieldName}.workspace`)
    };
}

function readControlConfig(
    value: JsonValue | undefined,
    current: ControlGlobalConfig["control"]
): ControlGlobalConfig["control"] {
    const control = value === undefined ? undefined : readRecord(value, "control");
    return {
        logLevel: readOptionalString(control?.logLevel, "control.logLevel") ?? current.logLevel
    };
}

function readMcpConfig(value: JsonValue | undefined, currentConfig: ControlConfig): ControlGlobalConfig["mcp"] {
    if (value === undefined) {
        return {
            ...currentConfig.mcp,
            auth: {
                ...currentConfig.mcp.auth,
                ...(currentConfig.mcp.auth.oauth2 === undefined ? {} : { oauth2: { ...currentConfig.mcp.auth.oauth2 } })
            }
        };
    }

    const mcp = readRecord(value, "mcp");
    const auth = readRecord(mcp.auth, "mcp.auth");
    const mode = readMcpAuthMode(auth.mode, "mcp.auth.mode");

    return {
        auth: {
            mode,
            oauth2: mode === "oauth2" ? readOauth2Config(auth.oauth2, currentConfig.mcp.auth.oauth2) : undefined
        },
        enabled: readBoolean(mcp.enabled, currentConfig.mcp.enabled, "mcp.enabled"),
        listenHost: readRequiredString(mcp.listenHost, "mcp.listenHost"),
        listenPort: readInteger(mcp.listenPort, "mcp.listenPort"),
        publicBaseUrl: readOptionalString(mcp.publicBaseUrl, "mcp.publicBaseUrl")
    };
}

function readOauth2Config(
    value: JsonValue | undefined,
    current: ControlGlobalConfig["mcp"]["auth"]["oauth2"]
): ControlGlobalConfig["mcp"]["auth"]["oauth2"] {
    if (value === undefined) {
        return current;
    }

    const oauth2 = readRecord(value, "mcp.auth.oauth2");
    return {
        audience: readOptionalString(oauth2.audience, "mcp.auth.oauth2.audience"),
        documentationUrl: readOptionalString(oauth2.documentationUrl, "mcp.auth.oauth2.documentationUrl"),
        issuer: readOptionalString(oauth2.issuer, "mcp.auth.oauth2.issuer"),
        jwksUri: readOptionalString(oauth2.jwksUri, "mcp.auth.oauth2.jwksUri"),
        requiredScopes: readStringArray(oauth2.requiredScopes, "mcp.auth.oauth2.requiredScopes"),
        resourceName: readRequiredString(oauth2.resourceName, "mcp.auth.oauth2.resourceName")
    };
}

function readLogsConfig(
    value: JsonValue | undefined,
    current: ControlInstanceConfig["logs"],
    fieldName: string
): ControlInstanceConfig["logs"] {
    if (value === undefined) {
        return current;
    }

    const logs = readRecord(value, fieldName);
    return {
        eventBufferSize: readOptionalInteger(logs.eventBufferSize, `${fieldName}.eventBufferSize`),
        retentionDays: readOptionalInteger(logs.retentionDays, `${fieldName}.retentionDays`)
    };
}

function readToolsConfig(
    value: JsonValue | undefined,
    current: ControlInstanceConfig["tools"],
    fieldName: string
): ControlInstanceConfig["tools"] {
    if (value === undefined) {
        return current;
    }

    const tools = readRecord(value, fieldName);
    return {
        scheduler: readToolSchedulerConfig(tools.scheduler, current?.scheduler, `${fieldName}.scheduler`)
    };
}

function readToolSchedulerConfig(
    value: JsonValue | undefined,
    current: NonNullable<ControlInstanceConfig["tools"]>["scheduler"],
    fieldName: string
): NonNullable<ControlInstanceConfig["tools"]>["scheduler"] {
    if (value === undefined) {
        return current;
    }

    const scheduler = readRecord(value, fieldName);
    return {
        maxRunning: readOptionalInteger(scheduler.maxRunning, `${fieldName}.maxRunning`),
        queueDepth: readOptionalInteger(scheduler.queueDepth, `${fieldName}.queueDepth`),
        queueTimeoutMs: readOptionalInteger(scheduler.queueTimeoutMs, `${fieldName}.queueTimeoutMs`),
        maxRunningPerSession: readOptionalInteger(scheduler.maxRunningPerSession, `${fieldName}.maxRunningPerSession`),
        queueDepthPerSession: readOptionalInteger(scheduler.queueDepthPerSession, `${fieldName}.queueDepthPerSession`),
        byTool: readToolSchedulerByTool(scheduler.byTool, current?.byTool, `${fieldName}.byTool`)
    };
}

function readToolSchedulerByTool(
    value: JsonValue | undefined,
    current: NonNullable<NonNullable<ControlInstanceConfig["tools"]>["scheduler"]>["byTool"],
    fieldName: string
): NonNullable<NonNullable<ControlInstanceConfig["tools"]>["scheduler"]>["byTool"] {
    if (value === undefined) {
        return current;
    }

    const byTool = readRecord(value, fieldName);
    return Object.fromEntries(
        Object.entries(byTool).map(([toolName, rawToolLimit]) => {
            const toolLimit = readRecord(rawToolLimit, `${fieldName}.${toolName}`);
            return [
                toolName,
                {
                    maxRunning: readOptionalInteger(toolLimit.maxRunning, `${fieldName}.${toolName}.maxRunning`),
                    queueDepth: readOptionalInteger(toolLimit.queueDepth, `${fieldName}.${toolName}.queueDepth`)
                }
            ];
        })
    );
}

function readInstanceMcpConfig(
    value: JsonValue | undefined,
    current: ControlInstanceConfig["mcp"] | undefined,
    instanceName: string,
    fieldName: string
): ControlInstanceConfig["mcp"] {
    const mcp = readRecord(value, fieldName);
    return {
        allowTools: readStringArray(mcp.allowTools, `${fieldName}.allowTools`),
        enabled: readBoolean(mcp.enabled, current?.enabled ?? true, `${fieldName}.enabled`),
        path: readOptionalString(mcp.path, `${fieldName}.path`) ?? `/${instanceName}/mcp`
    };
}

function readApprovalPolicy(
    value: JsonValue | undefined,
    current: ApprovalPolicy | undefined
): ApprovalPolicy | undefined {
    if (value === undefined) {
        return current;
    }

    const policy = readRecord(value, "approvalPolicy");
    const rules = policy.rules;

    return {
        mode: readApprovalPolicyMode(policy.mode, "approvalPolicy.mode"),
        rules:
            rules === undefined
                ? undefined
                : readArray(rules, "approvalPolicy.rules").map((entry, index) => {
                      const rule = readRecord(entry, `approvalPolicy.rules[${index}]`);
                      return {
                          decision: readApprovalPolicyDecision(rule.decision, `approvalPolicy.rules[${index}].decision`),
                          match: readApprovalPolicyMatch(rule.match, `approvalPolicy.rules[${index}].match`),
                          source: readApprovalPolicySource(rule.source, `approvalPolicy.rules[${index}].source`),
                          toolName: readOptionalString(rule.toolName, `approvalPolicy.rules[${index}].toolName`)
                      };
                  })
    };
}

function readSshConfig(
    value: JsonValue | undefined,
    current: ControlInstanceConfig["ssh"],
    fieldName: string
): ControlInstanceConfig["ssh"] {
    if (value === undefined) {
        return current;
    }

    const ssh = readRecord(value, fieldName);
    return {
        command: readOptionalString(ssh.command, `${fieldName}.command`)
    };
}

function readSecurityMode(value: JsonValue | undefined, current: string | undefined, fieldName: string): string {
    if (value === undefined) {
        return current ?? "disabled";
    }

    const security = readRecord(value, fieldName);
    return readOptionalString(security.mode, `${fieldName}.mode`) ?? current ?? "disabled";
}

function readInstanceName(params: JsonValue | undefined, methodName: string): string {
    const record = readRecord(params, methodName);
    return readRequiredString(record.instanceName, `${methodName}.instanceName`);
}

function readVersion(value: JsonValue | undefined, current: number): number {
    return value === undefined ? current : readInteger(value, "version");
}

function readProvider(value: JsonValue | undefined, fieldName: string): ControlInstanceConfig["provider"] {
    const provider = readRequiredString(value, fieldName);
    if (provider === "local" || provider === "ssh" || provider === "docker" || provider === "podman") {
        return provider;
    }

    throw invalidConfig(`${fieldName} must be one of local, ssh, docker, podman.`);
}

function readMcpAuthMode(value: JsonValue | undefined, fieldName: string): ControlMcpAuthMode {
    const mode = readRequiredString(value, fieldName);
    if (mode === "none" || mode === "oauth2" || mode === "token") {
        return mode;
    }

    throw invalidConfig(`${fieldName} must be one of none, oauth2, token.`);
}

function readApprovalPolicyMode(value: JsonValue | undefined, fieldName: string): ApprovalPolicy["mode"] {
    const mode = readRequiredString(value, fieldName);
    if (mode === "disabled" || mode === "allow" || mode === "ask" || mode === "deny") {
        return mode;
    }

    throw invalidConfig(`${fieldName} must be one of disabled, allow, ask, deny.`);
}

function readApprovalPolicyDecision(value: JsonValue | undefined, fieldName: string): NonNullable<ApprovalPolicy["rules"]>[number]["decision"] {
    const decision = readRequiredString(value, fieldName);
    if (decision === "allow" || decision === "ask" || decision === "deny") {
        return decision;
    }

    throw invalidConfig(`${fieldName} must be one of allow, ask, deny.`);
}

function readApprovalPolicyMatch(value: JsonValue | undefined, fieldName: string): "exact" {
    const match = readRequiredString(value, fieldName);
    if (match === "exact") {
        return match;
    }

    throw invalidConfig(`${fieldName} must be exact.`);
}

function readApprovalPolicySource(value: JsonValue | undefined, fieldName: string): NonNullable<ApprovalPolicy["rules"]>[number]["source"] {
    const source = readRequiredString(value, fieldName);
    if (source === "all" || source === "cli" || source === "tui" || source === "mcp") {
        return source;
    }

    throw invalidConfig(`${fieldName} must be one of all, cli, tui, mcp.`);
}

function readRecord(value: JsonValue | undefined, fieldName: string): Record<string, JsonValue> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidConfig(`${fieldName} must be an object.`);
    }

    return value as Record<string, JsonValue>;
}

function readArray(value: JsonValue | undefined, fieldName: string): JsonValue[] {
    if (!Array.isArray(value)) {
        throw invalidConfig(`${fieldName} must be an array.`);
    }

    return value;
}

function readRequiredString(value: JsonValue | undefined, fieldName: string): string {
    const normalized = readOptionalString(value, fieldName);
    if (normalized === undefined) {
        throw invalidConfig(`${fieldName} is required.`);
    }

    return normalized;
}

function readOptionalString(value: JsonValue | undefined, fieldName: string): string | undefined {
    if (value === undefined || value === null) {
        return undefined;
    }

    if (typeof value !== "string") {
        throw invalidConfig(`${fieldName} must be a string.`);
    }

    const normalized = value.trim();
    return normalized.length === 0 ? undefined : normalized;
}

function readBoolean(value: JsonValue | undefined, fallback: boolean, fieldName: string): boolean {
    if (value === undefined) {
        return fallback;
    }

    if (typeof value !== "boolean") {
        throw invalidConfig(`${fieldName} must be a boolean.`);
    }

    return value;
}

function readInteger(value: JsonValue | undefined, fieldName: string): number {
    if (typeof value !== "number" || !Number.isInteger(value)) {
        throw invalidConfig(`${fieldName} must be an integer.`);
    }

    return value;
}

function readOptionalInteger(value: JsonValue | undefined, fieldName: string): number | undefined {
    if (value === undefined) {
        return undefined;
    }

    return readInteger(value, fieldName);
}

function readStringArray(value: JsonValue | undefined, fieldName: string): string[] {
    const entries = readArray(value, fieldName);
    if (entries.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw invalidConfig(`${fieldName} must be a string array.`);
    }

    return entries.map((entry) => String(entry).trim());
}

function readStringRecord(
    value: JsonValue | undefined,
    fieldName: string,
    current: Record<string, string> | undefined
): Record<string, string> | undefined {
    if (value === undefined) {
        return current;
    }

    const record = readRecord(value, fieldName);
    return Object.fromEntries(
        Object.entries(record).map(([key, entryValue]) => {
            if (typeof entryValue !== "string") {
                throw invalidConfig(`${fieldName}.${key} must be a string.`);
            }

            return [key, entryValue];
        })
    );
}

function readRawValue<T>(value: JsonValue | undefined, fallback: T): T {
    return (value === undefined ? fallback : (value as T));
}

function resolveSecurityMode(mode: string | undefined): "disabled" | "workspace" {
    return mode === "workspace" ? "workspace" : "disabled";
}

function cloneApprovalPolicy(policy: ApprovalPolicy): ApprovalPolicy {
    return {
        mode: policy.mode,
        rules: policy.rules?.map((rule) => ({ ...rule }))
    };
}

function cloneInstanceConfig(instance: ControlInstanceConfig): ControlInstanceConfig {
    return {
        ...instance,
        approvalPolicy: instance.approvalPolicy === undefined ? undefined : cloneApprovalPolicy(instance.approvalPolicy),
        env: instance.env === undefined ? undefined : { ...instance.env },
        logs: instance.logs === undefined ? undefined : { ...instance.logs },
        mcp: {
            ...instance.mcp,
            allowTools: [...instance.mcp.allowTools]
        },
        security: instance.security === undefined ? undefined : { ...instance.security },
        ssh: instance.ssh === undefined ? undefined : { ...instance.ssh },
        tools: instance.tools === undefined ? undefined : cloneToolsConfig(instance.tools)
    };
}

function cloneToolsConfig(tools: NonNullable<ControlInstanceConfig["tools"]>): NonNullable<ControlInstanceConfig["tools"]> {
    return {
        scheduler:
            tools.scheduler === undefined
                ? undefined
                : {
                      ...tools.scheduler,
                      byTool:
                          tools.scheduler.byTool === undefined
                              ? undefined
                              : Object.fromEntries(
                                    Object.entries(tools.scheduler.byTool).map(([toolName, limits]) => [toolName, { ...limits }])
                                )
                  }
    };
}

function invalidConfig(message: string) {
    return createError({
        code: errorCodes.authConfigInvalid,
        message,
        retryable: false
    });
}

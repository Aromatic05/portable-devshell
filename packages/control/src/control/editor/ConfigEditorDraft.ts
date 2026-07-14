import { createError, errorCodes, type ApprovalPolicy, type JsonValue } from "@portable-devshell/shared";

import type {
    ControlConfig,
    ControlGlobalConfig,
    ControlInstanceConfig,
    ControlMcpAuthMode
} from "../config/codec/ConfigTomlCodec.js";
import { cloneInstanceConfig, resolveSecurityMode } from "./ConfigEditorValue.js";

export function readConfigDraft(params: JsonValue | undefined, currentConfig: ControlConfig): ControlConfig {
    const draft = readRecord(params, "control.validateConfigDraft");

    return {
        control: readControlConfig(draft.control, currentConfig.control),
        instances: readInstances(draft.instances, currentConfig),
        mcp: readMcpConfig(draft.mcp, currentConfig),
        version: readVersion(draft.version, currentConfig.version)
    };
}

export function readInstanceConfig(params: JsonValue | undefined, currentConfig: ControlConfig): ControlInstanceConfig {
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

export function readMcpConfig(value: JsonValue | undefined, currentConfig: ControlConfig): ControlGlobalConfig["mcp"] {
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
        fileEdit: readFileEditConfig(tools.fileEdit, current?.fileEdit, `${fieldName}.fileEdit`),
        scheduler: readToolSchedulerConfig(tools.scheduler, current?.scheduler, `${fieldName}.scheduler`)
    };
}

function readFileEditConfig(
    value: JsonValue | undefined,
    current: NonNullable<ControlInstanceConfig["tools"]>["fileEdit"],
    fieldName: string
): NonNullable<ControlInstanceConfig["tools"]>["fileEdit"] {
    if (value === undefined) {
        return current;
    }
    const fileEdit = readRecord(value, fieldName);
    const rawMode = readOptionalString(fileEdit.mode, `${fieldName}.mode`) ?? current?.mode ?? "text";
    if (rawMode !== "text" && rawMode !== "replace" && rawMode !== "patch" && rawMode !== "apply_patch") {
        throw invalidConfig(`${fieldName}.mode must be one of text, replace, patch, apply_patch`);
    }
    return { mode: rawMode };
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
    const tools = readRecord(mcp.tools, `${fieldName}.tools`);
    return {
        enabled: readBoolean(mcp.enabled, current?.enabled ?? true, `${fieldName}.enabled`),
        path: readOptionalString(mcp.path, `${fieldName}.path`) ?? `/${instanceName}/mcp`,
        tools: {
            capabilities: readToolCapabilityArray(tools.capabilities, `${fieldName}.tools.capabilities`),
            groups: readStringArray(tools.groups, `${fieldName}.tools.groups`)
        }
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

export function readInstanceName(params: JsonValue | undefined, methodName: string): string {
    const record = readRecord(params, methodName);
    return readRequiredString(record.instanceName, `${methodName}.instanceName`);
}

function readVersion(value: JsonValue | undefined, current: number): number {
    return value === undefined ? current : readInteger(value, "version");
}

function readProvider(value: JsonValue | undefined, fieldName: string): ControlInstanceConfig["provider"] {
    const provider = readRequiredString(value, fieldName);
    if (
        provider === "local" ||
        provider === "ssh" ||
        provider === "docker" ||
        provider === "podman" ||
        provider === "reverse"
    ) {
        return provider;
    }

    throw invalidConfig(`${fieldName} must be one of local, ssh, docker, podman, reverse.`);
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

function readToolCapabilityArray(value: JsonValue | undefined, fieldName: string): Array<"read" | "write" | "execute" | "manage"> {
    return readStringArray(value, fieldName).map((entry) => {
        if (entry === "read" || entry === "write" || entry === "execute" || entry === "manage") {
            return entry;
        }
        throw invalidConfig(`${fieldName} must contain only read, write, execute, or manage.`);
    });
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

function invalidConfig(message: string) {
    return createError({
        code: errorCodes.authConfigInvalid,
        message,
        retryable: false
    });
}

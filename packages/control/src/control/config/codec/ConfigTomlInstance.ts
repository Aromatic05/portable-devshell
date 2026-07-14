import { createError, errorCodes, type ApprovalPolicy } from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

import { encodeContainer, parseContainerConfig } from "./ConfigTomlContainer.js";
import type {
    ControlInstanceConfig,
    ControlInstanceToolsConfig,
    ControlToolSchedulerConfig,
    ControlToolSchedulerToolLimitConfig
} from "./ConfigTomlTypes.js";
import {
    asApprovalPolicyDecision,
    asApprovalPolicyMatch,
    asApprovalPolicyMode,
    asApprovalPolicySourceScope,
    asBoolean,
    asInteger,
    asOptionalArray,
    asOptionalInteger,
    asOptionalRecord,
    asOptionalString,
    asProviderKind,
    asRecord,
    asString,
    asStringArray,
    asStringRecord,
    asToolCapabilityArray,
    isStructuredConfigError,
    readFieldPath,
    type TomlRecord,
    withoutUndefined
} from "./ConfigTomlValue.js";

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
    const scheduler = asOptionalRecord(tools.scheduler, "tools.scheduler");
    return {
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

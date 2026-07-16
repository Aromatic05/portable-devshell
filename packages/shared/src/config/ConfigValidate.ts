import { configInputError } from "./ConfigIssue.js";
import {
    minimumAuditStorageBytes,
    type ControlConfig,
    type ControlInstanceConfig,
    type ControlToolSchedulerConfig
} from "./ConfigModel.js";

export function validateConfigSemantics(config: ControlConfig): ControlConfig {
    const names = new Set<string>();

    for (const [index, instance] of config.instances.entries()) {
        validateInstance(instance, index);
        if (names.has(instance.name)) {
            throw configInputError(
                "semantic",
                ["instances", index, "name"],
                "config.instance.duplicateName",
                `duplicates instance ${instance.name}`
            );
        }
        names.add(instance.name);
    }

    if (config.instances.some((instance) => instance.provider === "reverse")) {
        if (!config.mcp.enabled) {
            throw configInputError(
                "semantic",
                ["mcp", "enabled"],
                "config.reverse.mcpRequired",
                "must be true when reverse instances are configured"
            );
        }
        if (config.mcp.publicBaseUrl === undefined) {
            throw configInputError(
                "semantic",
                ["mcp", "publicBaseUrl"],
                "config.reverse.publicBaseUrlRequired",
                "is required when reverse instances are configured"
            );
        }
    }

    validateGlobalMcp(config);
    return config;
}

function validateInstance(instance: ControlInstanceConfig, index: number): void {
    const base = ["instances", index] as const;
    if (!/^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/u.test(instance.name)) {
        throw configInputError(
            "semantic",
            [...base, "name"],
            "config.instance.nameInvalid",
            "must contain at least one '-' and only letters, digits, and '-'"
        );
    }

    const expectedPath = `/${instance.name}/mcp`;
    if (instance.mcp.path !== expectedPath) {
        throw configInputError("semantic", [...base, "mcp", "path"], "config.instance.mcpPath", `must be ${expectedPath}`);
    }

    validateLogs(instance, base);
    validateScheduler(instance.tools?.scheduler, base);
    validateApprovalPolicy(instance, base);
    validateContainer(instance, base);
}

function validateGlobalMcp(config: ControlConfig): void {
    if (!Number.isSafeInteger(config.mcp.listenPort) || config.mcp.listenPort < 0 || config.mcp.listenPort > 65535) {
        throw configInputError(
            "semantic",
            ["mcp", "listenPort"],
            "config.mcp.listenPort",
            "must be an integer between 0 and 65535"
        );
    }

    if (config.mcp.publicBaseUrl !== undefined) {
        parseUrl(config.mcp.publicBaseUrl, ["mcp", "publicBaseUrl"]);
    }

    if (config.mcp.auth.mode === "oauth2") {
        const oauth2 = config.mcp.auth.oauth2;
        if (oauth2.documentationUrl !== undefined) parseUrl(oauth2.documentationUrl, ["mcp", "auth", "oauth2", "documentationUrl"]);
        if (oauth2.issuer !== undefined) parseUrl(oauth2.issuer, ["mcp", "auth", "oauth2", "issuer"]);
        if (oauth2.jwksUri !== undefined) parseUrl(oauth2.jwksUri, ["mcp", "auth", "oauth2", "jwksUri"]);
    }

    const publicHost = config.mcp.listenHost === "0.0.0.0" || config.mcp.listenHost === "::";
    const publicBaseUrl = config.mcp.publicBaseUrl !== undefined && !isLoopbackUrl(config.mcp.publicBaseUrl);
    if (config.mcp.auth.mode === "none" && (publicHost || publicBaseUrl)) {
        throw configInputError(
            "semantic",
            ["mcp", "auth", "mode"],
            "config.mcp.publicAuthRequired",
            "must not be none when MCP is publicly exposed"
        );
    }
}

function validateLogs(instance: ControlInstanceConfig, base: readonly (string | number)[]): void {
    const logs = instance.logs;
    if (logs === undefined) return;
    positiveInteger(logs.eventBufferSize, [...base, "logs", "eventBufferSize"]);
    positiveInteger(logs.retentionDays, [...base, "logs", "retentionDays"]);
    if (logs.maxBytes !== undefined && (!Number.isSafeInteger(logs.maxBytes) || logs.maxBytes < minimumAuditStorageBytes)) {
        throw configInputError(
            "semantic",
            [...base, "logs", "maxBytes"],
            "config.logs.maxBytes",
            `must be an integer of at least ${minimumAuditStorageBytes}`
        );
    }
}

function validateScheduler(scheduler: ControlToolSchedulerConfig | undefined, base: readonly (string | number)[]): void {
    if (scheduler === undefined) return;
    positiveInteger(scheduler.maxRunning, [...base, "tools", "scheduler", "maxRunning"]);
    nonNegativeInteger(scheduler.queueDepth, [...base, "tools", "scheduler", "queueDepth"]);
    positiveInteger(scheduler.queueTimeoutMs, [...base, "tools", "scheduler", "queueTimeoutMs"]);
    positiveInteger(scheduler.maxRunningPerSession, [...base, "tools", "scheduler", "maxRunningPerSession"]);
    nonNegativeInteger(scheduler.queueDepthPerSession, [...base, "tools", "scheduler", "queueDepthPerSession"]);
    for (const [toolName, limits] of Object.entries(scheduler.byTool ?? {})) {
        positiveInteger(limits.maxRunning, [...base, "tools", "scheduler", "byTool", toolName, "maxRunning"]);
        nonNegativeInteger(limits.queueDepth, [...base, "tools", "scheduler", "byTool", toolName, "queueDepth"]);
    }
}

function validateApprovalPolicy(instance: ControlInstanceConfig, base: readonly (string | number)[]): void {
    for (const [index, rule] of (instance.approvalPolicy?.rules ?? []).entries()) {
        if (rule.toolName !== undefined && rule.toolName.trim().length === 0) {
            throw configInputError(
                "semantic",
                [...base, "approvalPolicy", "rules", index, "toolName"],
                "config.approval.toolName",
                "must not be empty"
            );
        }
    }
}

function validateContainer(instance: ControlInstanceConfig, base: readonly (string | number)[]): void {
    const container = instance.container;
    if (container === undefined) return;
    if (container.mode === "preset" && container.preset.length === 0) {
        throw configInputError("semantic", [...base, "container", "preset"], "config.container.preset", "must not be empty");
    }
    if ("env" in container) {
        for (const [key, value] of Object.entries(container.env ?? {})) {
            if (key.length === 0 || value.length === 0) {
                throw configInputError(
                    "semantic",
                    [...base, "container", "env", key],
                    "config.container.env",
                    "key and value must not be empty"
                );
            }
        }
    }
    for (const [index, mount] of ("mounts" in container ? container.mounts ?? [] : []).entries()) {
        if (mount.source.length === 0) {
            throw configInputError("semantic", [...base, "container", "mounts", index, "source"], "config.mount.source", "must not be empty");
        }
        if (mount.target.length === 0) {
            throw configInputError("semantic", [...base, "container", "mounts", index, "target"], "config.mount.target", "must not be empty");
        }
    }
}

function positiveInteger(value: number | undefined, path: readonly (string | number)[]): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw configInputError("semantic", path, "config.number.positive", "must be a positive integer");
    }
}

function nonNegativeInteger(value: number | undefined, path: readonly (string | number)[]): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
        throw configInputError("semantic", path, "config.number.nonNegative", "must be a non-negative integer");
    }
}

function parseUrl(value: string, path: readonly (string | number)[]): URL {
    try {
        return new URL(value);
    } catch {
        throw configInputError("semantic", path, "config.url.invalid", "must be a valid URL");
    }
}

function isLoopbackUrl(value: string): boolean {
    const hostname = parseUrl(value, ["mcp", "publicBaseUrl"]).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}

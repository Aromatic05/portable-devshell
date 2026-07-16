import {
    configInputError,
    parseConfigGlobalDraft,
    parseConfigInstanceDraft,
    type ConfigGlobalDraft,
    type ConfigInstanceDraft,
    type ControlGlobalConfig,
    type ControlInstanceConfig
} from "@portable-devshell/shared";

import type { ConfigTomlDocument } from "./ConfigTomlCodec.js";

export class ControlGlobalTomlDocument {
    decode(document: ConfigTomlDocument): ConfigGlobalDraft {
        const record = asRecord(document);
        assertDocumentVersion(record.version, 1, ["version"]);
        if (record.instances !== undefined) {
            throw configInputError(
                "parse",
                ["instances"],
                "config.document.legacyInstances",
                "is not supported; move instances into ~/.devshell/control/instances/*.toml"
            );
        }
        const { version: _version, ...config } = record;
        return parseConfigGlobalDraft(config);
    }

    encode(config: ControlGlobalConfig): ConfigTomlDocument {
        return compact({
            version: 1,
            control: {
                logLevel: config.control.logLevel
            },
            mcp: {
                enabled: config.mcp.enabled,
                listenHost: config.mcp.listenHost,
                listenPort: config.mcp.listenPort,
                publicBaseUrl: config.mcp.publicBaseUrl,
                auth:
                    config.mcp.auth.mode === "oauth2"
                        ? {
                              mode: "oauth2",
                              oauth2: compact(config.mcp.auth.oauth2)
                          }
                        : { mode: config.mcp.auth.mode }
            }
        });
    }
}

export class ControlInstanceTomlDocument {
    decode(document: ConfigTomlDocument): ConfigInstanceDraft {
        const record = asRecord(document);
        assertDocumentVersion(record.version, 2, ["version"]);
        rejectLegacyField(record, "workerBinaryPath", "is not supported");
        rejectLegacyField(record, "host", "is not supported; use ssh.command");
        rejectLegacyField(record, "remoteCwd", "is not supported; use workspace");
        rejectLegacyField(record, "sshBinary", "is not supported; use ssh.command");
        const { version: _version, ...config } = record;
        return parseConfigInstanceDraft(config);
    }

    encode(instance: ControlInstanceConfig): ConfigTomlDocument {
        return compact({
            version: 2,
            name: instance.name,
            enabled: instance.enabled,
            provider: instance.provider,
            workspace: instance.workspace,
            container: instance.container,
            ssh: instance.ssh,
            dockerBinary: instance.dockerBinary,
            podmanBinary: instance.podmanBinary,
            env: instance.env,
            mcp: {
                enabled: instance.mcp.enabled,
                path: instance.mcp.path,
                tools: {
                    capabilities: [...instance.mcp.tools.capabilities],
                    groups: [...instance.mcp.tools.groups]
                }
            },
            logs: instance.logs,
            approvalPolicy: instance.approvalPolicy,
            tools: instance.tools,
            security: instance.security
        });
    }
}

function assertDocumentVersion(value: unknown, expected: number, path: readonly string[]): void {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw configInputError("parse", path, "config.document.versionType", "must be an integer");
    }
    if (value !== expected) {
        throw configInputError("parse", path, "config.document.versionUnsupported", `must be ${expected}`);
    }
}

function rejectLegacyField(record: Record<string, unknown>, key: string, message: string): void {
    if (record[key] !== undefined) {
        throw configInputError("parse", [key], "config.document.legacyField", message);
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInputError("parse", [], "config.document.object", "must be an object");
    }
    return value as Record<string, unknown>;
}

function compact(value: unknown): ConfigTomlDocument {
    return compactValue(value) as ConfigTomlDocument;
}

function compactValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compactValue);
    if (typeof value !== "object" || value === null || value instanceof Date) return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => [key, compactValue(entry)])
    );
}

import {
    configInputError,
    parseMcpAuthDraft,
    parseConfigGlobalDraft,
    parseConfigInstanceDraft,
    type ConfigGlobalDraft,
    type ConfigInstanceDraft,
    type ControlGlobalConfig,
    type ControlInstanceConfig
} from "@portable-devshell/shared";

import type { ConfigTomlDocument } from "./ControlConfigTomlCodec.js";

export class ControlGlobalTomlDocument {
    decode(document: ConfigTomlDocument): ConfigGlobalDraft {
        const record = asRecord(document);
        const version = readDocumentVersion(record.version);
        if (version !== 1 && version !== 2) {
            throw configInputError("parse", ["version"], "config.document.versionUnsupported", "must be 1 or 2");
        }
        if (record.instances !== undefined) {
            throw configInputError(
                "parse",
                ["instances"],
                "config.document.legacyInstances",
                "is not supported; move instances into ~/.devshell/control/instances/*.toml"
            );
        }
        const { version: _version, ...config } = record;
        if (version === 1) {
            const mcp = asRecord(config.mcp);
            const legacyAuth = mcp.auth === undefined ? undefined : parseMcpAuthDraft(mcp.auth, ["mcp", "auth"]);
            const { auth: _auth, ...mcpWithoutAuth } = mcp;
            return Object.assign(parseConfigGlobalDraft({ ...config, mcp: mcpWithoutAuth }), { legacyMcpAuth: legacyAuth });
        }
        return parseConfigGlobalDraft(config);
    }

    encode(config: ControlGlobalConfig): ConfigTomlDocument {
        return compact({
            version: 2,
            control: {
                logLevel: config.control.logLevel
            },
            mcp: {
                enabled: config.mcp.enabled,
                listenHost: config.mcp.listenHost,
                listenPort: config.mcp.listenPort,
                publicBaseUrl: config.mcp.publicBaseUrl
            },
            web: {
                auth: config.web.auth.mode,
                enabled: config.web.enabled,
                listenHost: config.web.listenHost,
                listenPort: config.web.listenPort,
                oauth2: config.web.auth.mode === "oauth2" ? compact(config.web.auth.oauth2) : undefined,
                publicBaseUrl: config.web.publicBaseUrl,
                token: config.web.auth.mode === "token" ? config.web.auth.token : undefined
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
                auth: instance.mcp.auth.mode,
                enabled: instance.mcp.enabled,
                oauth2: instance.mcp.auth.mode === "oauth2" ? compact(instance.mcp.auth.oauth2) : undefined,
                path: instance.mcp.path,
                token: instance.mcp.auth.mode === "token" ? instance.mcp.auth.token : undefined,
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

function readDocumentVersion(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw configInputError("parse", ["version"], "config.document.versionType", "must be an integer");
    }
    return value;
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

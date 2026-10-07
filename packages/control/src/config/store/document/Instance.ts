import {
    configInputError,
    parseConfigInstanceDraft,
    type ConfigInstanceDraft,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

import { migrateInstanceConfigV2OrV3 } from "../Migration.js";

import type { ConfigTomlDocument } from "../TomlCodec.js";

export class ControlInstanceTomlDocument {
    decode(document: ConfigTomlDocument): ConfigInstanceDraft {
        const record = asRecord(document);
        const version = readDocumentVersion(record.version);
        if (version !== 2 && version !== 3 && version !== 4) {
            throw configInputError(
                "parse",
                ["version"],
                "config.document.versionUnsupported",
                "must be 2, 3, or 4",
            );
        }
        rejectLegacyField(record, "workerBinaryPath", "is not supported");
        rejectLegacyField(record, "host", "is not supported; use ssh.command");
        rejectLegacyField(record, "remoteCwd", "is not supported");
        rejectLegacyField(
            record,
            "sshBinary",
            "is not supported; use ssh.command",
        );
        if (version === 3) {
            rejectLegacyField(
                record,
                "workspace",
                "is not supported; select an absolute workspace when creating an environment context",
            );
        }
        const { version: _version, ...versionless } = record;
        return version === 4
            ? parseConfigInstanceDraft(versionless)
            : migrateInstanceConfigV2OrV3(versionless, version);
    }

    encode(instance: ControlInstanceConfig): ConfigTomlDocument {
        return compact({
            version: 4,
            name: instance.name,
            enabled: instance.enabled,
            provider: instance.provider,
            container: instance.container,
            ssh: instance.ssh,
            dockerBinary: instance.dockerBinary,
            podmanBinary: instance.podmanBinary,
            env: instance.env,
            extensions: {
                model: [...instance.extensions.model],
            },
            alerts: instance.alerts,
            mcp: {
                auth: instance.mcp.auth.mode,
                contextMode: instance.mcp.contextMode,
                enabled: instance.mcp.enabled,
                oauth2:
                    instance.mcp.auth.mode === "oauth2"
                        ? compact(instance.mcp.auth.oauth2)
                        : undefined,
                path: instance.mcp.path,
                token:
                    instance.mcp.auth.mode === "token"
                        ? instance.mcp.auth.token
                        : undefined,
            },
            logs: instance.logs,
            approvalPolicy: instance.approvalPolicy,
            tools: instance.tools,
            security: instance.security,
            workspace: instance.workspace,
        });
    }
}

function readDocumentVersion(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw configInputError(
            "parse",
            ["version"],
            "config.document.versionType",
            "must be an integer",
        );
    }
    return value;
}

function rejectLegacyField(
    record: Record<string, unknown>,
    key: string,
    message: string,
): void {
    if (record[key] !== undefined) {
        throw configInputError(
            "parse",
            [key],
            "config.document.legacyField",
            message,
        );
    }
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInputError(
            "parse",
            [],
            "config.document.object",
            "must be an object",
        );
    }
    return value as Record<string, unknown>;
}

function compact(value: unknown): ConfigTomlDocument {
    return compactValue(value) as ConfigTomlDocument;
}

function compactValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(compactValue);
    if (typeof value !== "object" || value === null || value instanceof Date)
        return value;
    return Object.fromEntries(
        Object.entries(value)
            .filter(([, entry]) => entry !== undefined)
            .map(([key, entry]) => [key, compactValue(entry)]),
    );
}

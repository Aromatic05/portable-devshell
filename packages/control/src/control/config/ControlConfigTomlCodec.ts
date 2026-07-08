import { createError, errorCodes } from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

export type ControlProviderKind = "docker" | "local" | "podman" | "ssh";
export type ControlMcpAuthMode = "none" | "oauth2" | "token";

export interface ControlInstanceLogsConfig {
    eventBufferSize?: number;
    retentionDays?: number;
}

export interface ControlInstanceMcpConfig {
    allowTools: string[];
    enabled: boolean;
    path?: string;
}

export interface ControlInstanceSecurityConfig {
    mode?: string;
}

export interface ControlInstanceConfig {
    container?: string;
    dockerBinary?: string;
    enabled: boolean;
    env?: Record<string, string>;
    host?: string;
    logs?: ControlInstanceLogsConfig;
    mcp: ControlInstanceMcpConfig;
    name: string;
    podmanBinary?: string;
    provider: ControlProviderKind;
    remoteCwd?: string;
    security?: ControlInstanceSecurityConfig;
    sshBinary?: string;
    workspace?: string;
}

export interface ControlGlobalConfig {
    control: {
        logLevel: string;
    };
    mcp: {
        auth: {
            mode: ControlMcpAuthMode;
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
                    mode: config.mcp.auth.mode
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
                    mode: asAuthMode(asString(auth.mode, "mcp.auth.mode"))
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
            version: 1,
            name: instance.name,
            enabled: instance.enabled,
            provider: instance.provider,
            ...(instance.workspace === undefined ? {} : { workspace: instance.workspace }),
            ...(instance.host === undefined ? {} : { host: instance.host }),
            ...(instance.remoteCwd === undefined ? {} : { remoteCwd: instance.remoteCwd }),
            ...(instance.container === undefined ? {} : { container: instance.container }),
            ...(instance.sshBinary === undefined ? {} : { sshBinary: instance.sshBinary }),
            ...(instance.dockerBinary === undefined ? {} : { dockerBinary: instance.dockerBinary }),
            ...(instance.podmanBinary === undefined ? {} : { podmanBinary: instance.podmanBinary }),
            ...(instance.env === undefined || Object.keys(instance.env).length === 0 ? {} : { env: instance.env }),
            mcp: {
                enabled: instance.mcp.enabled,
                allowTools: [...instance.mcp.allowTools],
                ...(instance.mcp.path === undefined ? {} : { path: instance.mcp.path })
            },
            ...(instance.logs === undefined ? {} : { logs: withoutUndefined(instance.logs) }),
            ...(instance.security === undefined ? {} : { security: withoutUndefined(instance.security) })
        });
    }
}

function parseInstanceDocument(document: TomlRecord): ControlInstanceConfig {
    const env = asOptionalRecord(document.env, "env");
    const mcp = asRecord(document.mcp, "mcp");
    const logs = asOptionalRecord(document.logs, "logs");
    const security = asOptionalRecord(document.security, "security");

    if (document.workerBinaryPath !== undefined) {
        throw new Error("workerBinaryPath is not supported");
    }

    if (asInteger(document.version, "version") !== 1) {
        throw new Error("version must be 1");
    }

    return {
        container: asOptionalString(document.container, "container"),
        dockerBinary: asOptionalString(document.dockerBinary, "dockerBinary"),
        enabled: asBoolean(document.enabled, "enabled"),
        env: env === undefined ? undefined : asStringRecord(env, "env"),
        host: asOptionalString(document.host, "host"),
        logs:
            logs === undefined
                ? undefined
                : {
                      eventBufferSize: asOptionalInteger(logs.eventBufferSize, "logs.eventBufferSize"),
                      retentionDays: asOptionalInteger(logs.retentionDays, "logs.retentionDays")
                  },
        mcp: {
            allowTools: asStringArray(mcp.allowTools, "mcp.allowTools"),
            enabled: asBoolean(mcp.enabled, "mcp.enabled"),
            path: asOptionalString(mcp.path, "mcp.path")
        },
        name: asString(document.name, "name"),
        podmanBinary: asOptionalString(document.podmanBinary, "podmanBinary"),
        provider: asProviderKind(asString(document.provider, "provider")),
        remoteCwd: asOptionalString(document.remoteCwd, "remoteCwd"),
        security: security === undefined ? undefined : { mode: asOptionalString(security.mode, "security.mode") },
        sshBinary: asOptionalString(document.sshBinary, "sshBinary"),
        workspace: asOptionalString(document.workspace, "workspace")
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

function asAuthMode(value: string): ControlMcpAuthMode {
    if (value === "none" || value === "token" || value === "oauth2") {
        return value;
    }

    throw new Error(`unsupported mcp.auth.mode: ${value}`);
}

function isStructuredConfigError(error: unknown): error is { code: string } {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function readFieldPath(message: string): string | undefined {
    const match = message.match(/^([A-Za-z0-9_.[\]]+)\s+/u);
    return match?.[1];
}

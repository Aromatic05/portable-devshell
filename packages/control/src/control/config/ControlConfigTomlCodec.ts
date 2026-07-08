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
    defaultWorkspace?: string;
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
}

export interface ControlConfig {
    control: {
        logLevel: string;
    };
    instances: ControlInstanceConfig[];
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

type TomlRecord = TomlTableWithoutBigInt;

export class ControlConfigTomlCodec {
    decode(source: string): ControlConfig {
        return this.#fromTomlDocument(parse(source) as TomlTableWithoutBigInt);
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
            },
            instances: config.instances.map((instance) => ({
                name: instance.name,
                enabled: instance.enabled,
                provider: instance.provider,
                ...(instance.defaultWorkspace === undefined ? {} : { defaultWorkspace: instance.defaultWorkspace }),
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
            }))
        });
    }

    #fromTomlDocument(document: TomlRecord): ControlConfig {
        const control = asRecord(document.control, "control");
        const mcp = asRecord(document.mcp, "mcp");
        const auth = asRecord(mcp.auth, "mcp.auth");
        const instances = document.instances;

        if (instances !== undefined && !Array.isArray(instances)) {
            throw new Error("instances must be an array of tables");
        }

        return {
            control: {
                logLevel: asString(control.logLevel, "control.logLevel")
            },
            instances: (instances as TomlRecord[] | undefined)?.map((instance, index) => this.#parseInstance(instance, index)) ?? [],
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

    #parseInstance(instance: TomlRecord, index: number): ControlInstanceConfig {
        const env = asOptionalRecord(instance.env, `instances[${index}].env`);
        const mcp = asRecord(instance.mcp, `instances[${index}].mcp`);
        const logs = asOptionalRecord(instance.logs, `instances[${index}].logs`);
        const security = asOptionalRecord(instance.security, `instances[${index}].security`);

        if (instance.workerBinaryPath !== undefined) {
            throw new Error(`instances[${index}].workerBinaryPath is not supported`);
        }

        return {
            container: asOptionalString(instance.container, `instances[${index}].container`),
            defaultWorkspace: asOptionalString(instance.defaultWorkspace, `instances[${index}].defaultWorkspace`),
            dockerBinary: asOptionalString(instance.dockerBinary, `instances[${index}].dockerBinary`),
            enabled: asBoolean(instance.enabled, `instances[${index}].enabled`),
            env: env === undefined ? undefined : asStringRecord(env, `instances[${index}].env`),
            host: asOptionalString(instance.host, `instances[${index}].host`),
            logs:
                logs === undefined
                    ? undefined
                    : {
                          eventBufferSize: asOptionalInteger(logs.eventBufferSize, `instances[${index}].logs.eventBufferSize`),
                          retentionDays: asOptionalInteger(logs.retentionDays, `instances[${index}].logs.retentionDays`)
                      },
            mcp: {
                allowTools: asStringArray(mcp.allowTools, `instances[${index}].mcp.allowTools`),
                enabled: asBoolean(mcp.enabled, `instances[${index}].mcp.enabled`),
                path: asOptionalString(mcp.path, `instances[${index}].mcp.path`)
            },
            name: asString(instance.name, `instances[${index}].name`),
            podmanBinary: asOptionalString(instance.podmanBinary, `instances[${index}].podmanBinary`),
            provider: asProviderKind(asString(instance.provider, `instances[${index}].provider`)),
            remoteCwd: asOptionalString(instance.remoteCwd, `instances[${index}].remoteCwd`),
            security: security === undefined ? undefined : { mode: asOptionalString(security.mode, `instances[${index}].security.mode`) },
            sshBinary: asOptionalString(instance.sshBinary, `instances[${index}].sshBinary`)
        };
    }
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

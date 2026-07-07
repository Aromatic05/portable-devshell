type TomlPrimitive = boolean | number | string;
interface TomlRecord {
    [key: string]: TomlValue;
}
type TomlValue = TomlPrimitive | TomlPrimitive[] | TomlRecord | TomlRecord[];

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
    workerBinaryPath?: string;
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

export class ControlConfigTomlCodec {
    decode(source: string): ControlConfig {
        return this.#fromTomlDocument(parseTomlDocument(source));
    }

    encode(config: ControlConfig): string {
        const lines: string[] = [];
        lines.push(`version = ${config.version}`);
        lines.push("");
        lines.push("[control]");
        lines.push(`logLevel = ${formatTomlString(config.control.logLevel)}`);
        lines.push("");
        lines.push("[mcp]");
        lines.push(`enabled = ${formatTomlBoolean(config.mcp.enabled)}`);
        lines.push(`listenHost = ${formatTomlString(config.mcp.listenHost)}`);
        lines.push(`listenPort = ${config.mcp.listenPort}`);

        if (config.mcp.publicBaseUrl !== undefined) {
            lines.push(`publicBaseUrl = ${formatTomlString(config.mcp.publicBaseUrl)}`);
        }

        lines.push("");
        lines.push("[mcp.auth]");
        lines.push(`mode = ${formatTomlString(config.mcp.auth.mode)}`);

        for (const instance of config.instances) {
            lines.push("");
            lines.push("[[instances]]");
            lines.push(`name = ${formatTomlString(instance.name)}`);
            lines.push(`enabled = ${formatTomlBoolean(instance.enabled)}`);
            lines.push(`provider = ${formatTomlString(instance.provider)}`);

            if (instance.defaultWorkspace !== undefined) {
                lines.push(`defaultWorkspace = ${formatTomlString(instance.defaultWorkspace)}`);
            }

            if (instance.workerBinaryPath !== undefined) {
                lines.push(`workerBinaryPath = ${formatTomlString(instance.workerBinaryPath)}`);
            }

            if (instance.host !== undefined) {
                lines.push(`host = ${formatTomlString(instance.host)}`);
            }

            if (instance.remoteCwd !== undefined) {
                lines.push(`remoteCwd = ${formatTomlString(instance.remoteCwd)}`);
            }

            if (instance.container !== undefined) {
                lines.push(`container = ${formatTomlString(instance.container)}`);
            }

            if (instance.sshBinary !== undefined) {
                lines.push(`sshBinary = ${formatTomlString(instance.sshBinary)}`);
            }

            if (instance.dockerBinary !== undefined) {
                lines.push(`dockerBinary = ${formatTomlString(instance.dockerBinary)}`);
            }

            if (instance.podmanBinary !== undefined) {
                lines.push(`podmanBinary = ${formatTomlString(instance.podmanBinary)}`);
            }

            if (instance.env !== undefined && Object.keys(instance.env).length > 0) {
                lines.push("");
                lines.push("[instances.env]");
                for (const [key, value] of Object.entries(instance.env)) {
                    lines.push(`${key} = ${formatTomlString(value)}`);
                }
            }

            lines.push("");
            lines.push("[instances.mcp]");
            lines.push(`enabled = ${formatTomlBoolean(instance.mcp.enabled)}`);
            lines.push(`allowTools = ${formatTomlStringArray(instance.mcp.allowTools)}`);

            if (instance.mcp.path !== undefined) {
                lines.push(`path = ${formatTomlString(instance.mcp.path)}`);
            }

            if (instance.logs !== undefined) {
                lines.push("");
                lines.push("[instances.logs]");

                if (instance.logs.eventBufferSize !== undefined) {
                    lines.push(`eventBufferSize = ${instance.logs.eventBufferSize}`);
                }

                if (instance.logs.retentionDays !== undefined) {
                    lines.push(`retentionDays = ${instance.logs.retentionDays}`);
                }
            }

            if (instance.security !== undefined) {
                lines.push("");
                lines.push("[instances.security]");

                if (instance.security.mode !== undefined) {
                    lines.push(`mode = ${formatTomlString(instance.security.mode)}`);
                }
            }
        }

        lines.push("");
        return lines.join("\n");
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
            sshBinary: asOptionalString(instance.sshBinary, `instances[${index}].sshBinary`),
            workerBinaryPath: asOptionalString(instance.workerBinaryPath, `instances[${index}].workerBinaryPath`)
        };
    }
}

function parseTomlDocument(source: string): TomlRecord {
    const document: TomlRecord = {};
    let currentRecord = document;
    let currentInstance: TomlRecord | undefined;

    for (const rawLine of source.split(/\r?\n/u)) {
        const line = stripComment(rawLine).trim();

        if (line.length === 0) {
            continue;
        }

        if (line.startsWith("[[") && line.endsWith("]]")) {
            const path = line.slice(2, -2).trim();
            if (path !== "instances") {
                throw new Error(`unsupported array table: ${path}`);
            }

            const instances = (document.instances ??= []) as TomlRecord[];
            currentInstance = {};
            instances.push(currentInstance);
            currentRecord = currentInstance;
            continue;
        }

        if (line.startsWith("[") && line.endsWith("]")) {
            const path = line.slice(1, -1).trim();
            currentRecord = resolveTable(document, path, currentInstance);
            continue;
        }

        const separatorIndex = line.indexOf("=");
        if (separatorIndex === -1) {
            throw new Error(`invalid TOML line: ${line}`);
        }

        const key = line.slice(0, separatorIndex).trim();
        const rawValue = line.slice(separatorIndex + 1).trim();
        currentRecord[key] = parseTomlValue(rawValue);
    }

    return document;
}

function resolveTable(document: TomlRecord, path: string, currentInstance: TomlRecord | undefined): TomlRecord {
    if (path === "control" || path === "mcp" || path === "mcp.auth") {
        return ensureTable(document, path.split("."));
    }

    if (path === "instances.env" || path === "instances.logs" || path === "instances.mcp" || path === "instances.security") {
        if (currentInstance === undefined) {
            throw new Error(`${path} requires an [[instances]] table`);
        }

        return ensureTable(currentInstance, path.split(".").slice(1));
    }

    throw new Error(`unsupported table: ${path}`);
}

function ensureTable(root: TomlRecord, path: string[]): TomlRecord {
    let current = root;

    for (const segment of path) {
        const next = current[segment];

        if (next === undefined) {
            const created: TomlRecord = {};
            current[segment] = created;
            current = created;
            continue;
        }

        if (!isRecord(next)) {
            throw new Error(`${path.join(".")} must be a table`);
        }

        current = next;
    }

    return current;
}

function parseTomlValue(value: string): TomlPrimitive | TomlPrimitive[] {
    if (value === "true" || value === "false") {
        return value === "true";
    }

    if (value.startsWith("\"") && value.endsWith("\"")) {
        return value.slice(1, -1).replaceAll("\\\"", "\"").replaceAll("\\\\", "\\");
    }

    if (value.startsWith("[") && value.endsWith("]")) {
        const inner = value.slice(1, -1).trim();
        if (inner.length === 0) {
            return [];
        }

        return splitTomlArray(inner).map((entry) => {
            const parsed = parseTomlValue(entry);
            if (Array.isArray(parsed) || typeof parsed === "boolean" || typeof parsed === "number") {
                throw new Error("only string arrays are supported");
            }

            return parsed;
        });
    }

    if (/^-?\d+$/u.test(value)) {
        return Number.parseInt(value, 10);
    }

    throw new Error(`unsupported TOML value: ${value}`);
}

function splitTomlArray(value: string): string[] {
    const entries: string[] = [];
    let current = "";
    let inString = false;

    for (const character of value) {
        if (character === "\"" && !current.endsWith("\\")) {
            inString = !inString;
        }

        if (character === "," && !inString) {
            entries.push(current.trim());
            current = "";
            continue;
        }

        current += character;
    }

    if (current.trim().length > 0) {
        entries.push(current.trim());
    }

    return entries;
}

function stripComment(line: string): string {
    let inString = false;

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];

        if (character === "\"" && line[index - 1] !== "\\") {
            inString = !inString;
        }

        if (character === "#" && !inString) {
            return line.slice(0, index);
        }
    }

    return line;
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

function formatTomlBoolean(value: boolean): string {
    return value ? "true" : "false";
}

function formatTomlString(value: string): string {
    return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

function formatTomlStringArray(values: readonly string[]): string {
    return `[${values.map((value) => formatTomlString(value)).join(", ")}]`;
}

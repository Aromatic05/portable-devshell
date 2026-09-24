import type { ExtensionJsonValue } from "@portable-devshell/extension";

export type AccessTargetKind = "mcp" | "web";
export type AccessProviderKind = "cloudflared" | "frp" | "ssh";

interface AccessEndpointBase {
    readonly enabled: boolean;
    readonly id: string;
    readonly provider: AccessProviderKind;
    readonly target: AccessTargetKind;
}

export interface CloudflaredAccessEndpoint extends AccessEndpointBase {
    readonly arguments?: readonly string[];
    readonly binary?: string;
    readonly provider: "cloudflared";
    readonly publicUrl?: string;
    readonly token: string;
}

export interface FrpAccessEndpoint extends AccessEndpointBase {
    readonly arguments?: readonly string[];
    readonly binary?: string;
    readonly provider: "frp";
    readonly publicUrl?: string;
    readonly remotePort: number;
    readonly serverHost: string;
    readonly serverPort: number;
    readonly token?: string;
}

export interface SshAccessEndpoint extends AccessEndpointBase {
    readonly binary?: string;
    readonly host: string;
    readonly identityFile?: string;
    readonly options?: readonly string[];
    readonly port: number;
    readonly provider: "ssh";
    readonly publicUrl?: string;
    readonly remoteBindHost: string;
    readonly remotePort: number;
    readonly user?: string;
}

export type AccessEndpoint =
    | CloudflaredAccessEndpoint
    | FrpAccessEndpoint
    | SshAccessEndpoint;

export interface AccessConfig {
    readonly endpoints: readonly AccessEndpoint[];
}

export function parseAccessConfig(value: ExtensionJsonValue | undefined): AccessConfig {
    if (!isRecord(value)) throw new TypeError("Access Config must be an object.");
    const endpoints = value.endpoints;
    if (!Array.isArray(endpoints))
        throw new TypeError("Access Config endpoints must be an array.");
    const parsed = endpoints.map((entry, index) => parseEndpoint(entry, index));
    const ids = parsed.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length)
        throw new TypeError("Access endpoint ids must be unique.");
    return Object.freeze({ endpoints: Object.freeze(parsed) });
}

export function endpointToJson(endpoint: AccessEndpoint): ExtensionJsonValue {
    return structuredClone(endpoint) as unknown as ExtensionJsonValue;
}

function parseEndpoint(value: unknown, index: number): AccessEndpoint {
    if (!isRecord(value))
        throw new TypeError(`Access endpoint ${index} must be an object.`);
    const id = readId(value.id, `endpoints[${index}].id`);
    const enabled = readBoolean(value.enabled, `endpoints[${index}].enabled`);
    const provider = readProvider(value.provider, `endpoints[${index}].provider`);
    const target = readTarget(value.target, `endpoints[${index}].target`);
    const binary = readOptionalString(value.binary, `endpoints[${index}].binary`);

    if (provider === "cloudflared") {
        return Object.freeze({
            ...(binary === undefined ? {} : { binary }),
            ...(value.arguments === undefined
                ? {}
                : {
                      arguments: Object.freeze(
                          readStringArray(
                              value.arguments,
                              `endpoints[${index}].arguments`,
                          ),
                      ),
                  }),
            enabled,
            id,
            provider,
            ...(value.publicUrl === undefined
                ? {}
                : {
                      publicUrl: readHttpUrl(
                          value.publicUrl,
                          `endpoints[${index}].publicUrl`,
                      ),
                  }),
            target,
            token: readString(value.token, `endpoints[${index}].token`),
        });
    }
    if (provider === "frp") {
        return Object.freeze({
            ...(value.arguments === undefined
                ? {}
                : {
                      arguments: Object.freeze(
                          readStringArray(
                              value.arguments,
                              `endpoints[${index}].arguments`,
                          ),
                      ),
                  }),
            ...(binary === undefined ? {} : { binary }),
            enabled,
            id,
            provider,
            ...(value.publicUrl === undefined
                ? {}
                : {
                      publicUrl: readHttpUrl(
                          value.publicUrl,
                          `endpoints[${index}].publicUrl`,
                      ),
                  }),
            remotePort: readPort(
                value.remotePort,
                `endpoints[${index}].remotePort`,
            ),
            serverHost: readString(
                value.serverHost,
                `endpoints[${index}].serverHost`,
            ),
            serverPort:
                value.serverPort === undefined
                    ? 7000
                    : readPort(
                          value.serverPort,
                          `endpoints[${index}].serverPort`,
                      ),
            target,
            ...(value.token === undefined
                ? {}
                : {
                      token: readStringAllowEmpty(
                          value.token,
                          `endpoints[${index}].token`,
                      ),
                  }),
        });
    }
    return Object.freeze({
        ...(binary === undefined ? {} : { binary }),
        enabled,
        host: readString(value.host, `endpoints[${index}].host`),
        id,
        ...(value.identityFile === undefined
            ? {}
            : {
                  identityFile: readString(
                      value.identityFile,
                      `endpoints[${index}].identityFile`,
                  ),
              }),
        ...(value.options === undefined
            ? {}
            : {
                  options: Object.freeze(
                      readStringArray(
                          value.options,
                          `endpoints[${index}].options`,
                      ),
                  ),
              }),
        port:
            value.port === undefined
                ? 22
                : readPort(value.port, `endpoints[${index}].port`),
        provider,
        ...(value.publicUrl === undefined
            ? {}
            : {
                  publicUrl: readHttpUrl(
                      value.publicUrl,
                      `endpoints[${index}].publicUrl`,
                  ),
              }),
        remoteBindHost:
            value.remoteBindHost === undefined
                ? "127.0.0.1"
                : readString(
                      value.remoteBindHost,
                      `endpoints[${index}].remoteBindHost`,
                  ),
        remotePort: readPort(
            value.remotePort,
            `endpoints[${index}].remotePort`,
        ),
        target,
        ...(value.user === undefined
            ? {}
            : { user: readString(value.user, `endpoints[${index}].user`) }),
    });
}

function readProvider(value: unknown, field: string): AccessProviderKind {
    if (value === "cloudflared" || value === "frp" || value === "ssh")
        return value;
    throw new TypeError(`${field} must be cloudflared, frp, or ssh.`);
}

function readTarget(value: unknown, field: string): AccessTargetKind {
    if (value === "mcp" || value === "web") return value;
    throw new TypeError(`${field} must be mcp or web.`);
}

function readId(value: unknown, field: string): string {
    const id = readString(value, field);
    if (/^[a-z][a-z0-9-]*$/u.test(id)) return id;
    throw new TypeError(`${field} must match [a-z][a-z0-9-]*.`);
}

function readPort(value: unknown, field: string): number {
    if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 1 &&
        value <= 65535
    )
        return value;
    throw new TypeError(`${field} must be an integer from 1 through 65535.`);
}

function readBoolean(value: unknown, field: string): boolean {
    if (typeof value === "boolean") return value;
    throw new TypeError(`${field} must be a boolean.`);
}

function readOptionalString(value: unknown, field: string): string | undefined {
    return value === undefined ? undefined : readString(value, field);
}

function readString(value: unknown, field: string): string {
    if (typeof value === "string" && value.trim() === value && value.length > 0)
        return value;
    throw new TypeError(`${field} must be a non-empty trimmed string.`);
}

function readStringAllowEmpty(value: unknown, field: string): string {
    if (typeof value === "string") return value;
    throw new TypeError(`${field} must be a string.`);
}

function readHttpUrl(value: unknown, field: string): string {
    const source = readString(value, field);
    let url: URL;
    try {
        url = new URL(source);
    } catch (error) {
        throw new TypeError(`${field} must be an absolute HTTP URL.`, {
            cause: error,
        });
    }
    if (url.protocol !== "http:" && url.protocol !== "https:")
        throw new TypeError(`${field} must use http or https.`);
    return url.href;
}

function readStringArray(value: unknown, field: string): string[] {
    if (!Array.isArray(value)) throw new TypeError(`${field} must be an array.`);
    return value.map((entry, index) => {
        if (typeof entry === "string") return entry;
        throw new TypeError(`${field}[${index}] must be a string.`);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

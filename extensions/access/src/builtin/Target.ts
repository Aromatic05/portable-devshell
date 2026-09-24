import type { ExtensionConfig, ExtensionJsonValue } from "@portable-devshell/extension";

import type { AccessTargetKind } from "./Config.js";

export interface AccessTarget {
    readonly kind: AccessTargetKind;
    readonly origin: URL;
    readonly publicBaseUrl?: string;
}

export type AccessTargetResolution =
    | { readonly available: true; readonly target: AccessTarget }
    | { readonly available: false; readonly reason: string };

export async function resolveAccessTarget(
    config: ExtensionConfig,
    kind: AccessTargetKind,
): Promise<AccessTargetResolution> {
    const [enabled, listenHost, listenPort, publicBaseUrl] = await Promise.all([
        config.get(`${kind}.enabled`),
        config.get(`${kind}.listenHost`),
        config.get(`${kind}.listenPort`),
        config.get(`${kind}.publicBaseUrl`),
    ]);
    if (enabled !== true) {
        return {
            available: false,
            reason: `${kind.toUpperCase()} endpoint is disabled.`,
        };
    }
    const host = normalizeLoopbackHost(readString(listenHost, `${kind}.listenHost`));
    const port = readPort(listenPort, `${kind}.listenPort`);
    if (port === 0) {
        return {
            available: false,
            reason: `${kind.toUpperCase()} endpoint uses dynamic listenPort 0; Access requires an explicit listen port.`,
        };
    }
    return {
        available: true,
        target: Object.freeze({
            kind,
            origin: new URL(`http://${formatUrlHost(host)}:${port}/`),
            ...(publicBaseUrl === undefined
                ? {}
                : {
                      publicBaseUrl: readString(
                          publicBaseUrl,
                          `${kind}.publicBaseUrl`,
                      ),
                  }),
        }),
    };
}

function normalizeLoopbackHost(host: string): string {
    if (host === "0.0.0.0" || host === "*") return "127.0.0.1";
    if (host === "::" || host === "[::]") return "::1";
    return host;
}

function formatUrlHost(host: string): string {
    if (host.startsWith("[") && host.endsWith("]")) return host;
    return host.includes(":") ? `[${host}]` : host;
}

function readString(value: ExtensionJsonValue | undefined, field: string): string {
    if (typeof value === "string" && value.length > 0) return value;
    throw new TypeError(`Access requires string Config path ${field}.`);
}

function readPort(value: ExtensionJsonValue | undefined, field: string): number {
    if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value >= 0 &&
        value <= 65535
    )
        return value;
    throw new TypeError(
        `Access requires integer Config path ${field} between 0 and 65535.`,
    );
}

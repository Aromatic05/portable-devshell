import { createError, errorCodes } from "@portable-devshell/shared";
import { parse, stringify, type TomlTableWithoutBigInt } from "smol-toml";

import type { ControlConfig, ControlGlobalConfig, ControlMcpOAuth2Config } from "./ConfigTomlTypes.js";
import {
    asAuthMode,
    asBoolean,
    asInteger,
    asOptionalString,
    asRecord,
    asString,
    asStringArray,
    isStructuredConfigError,
    readFieldPath,
    type TomlRecord,
    withoutUndefined
} from "./ConfigTomlValue.js";

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
                    mode: config.mcp.auth.mode,
                    ...(config.mcp.auth.oauth2 === undefined ? {} : { oauth2: withoutUndefined(config.mcp.auth.oauth2) })
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
                    mode: asAuthMode(asString(auth.mode, "mcp.auth.mode")),
                    oauth2: auth.oauth2 === undefined ? undefined : parseOauth2Config(auth.oauth2)
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

function parseOauth2Config(value: unknown): ControlMcpOAuth2Config {
    const oauth2 = asRecord(value, "mcp.auth.oauth2");

    return {
        audience: asOptionalString(oauth2.audience, "mcp.auth.oauth2.audience"),
        documentationUrl: asOptionalString(oauth2.documentationUrl, "mcp.auth.oauth2.documentationUrl"),
        issuer: asOptionalString(oauth2.issuer, "mcp.auth.oauth2.issuer"),
        jwksUri: asOptionalString(oauth2.jwksUri, "mcp.auth.oauth2.jwksUri"),
        requiredScopes: oauth2.requiredScopes === undefined ? [] : asStringArray(oauth2.requiredScopes, "mcp.auth.oauth2.requiredScopes"),
        resourceName: asString(oauth2.resourceName, "mcp.auth.oauth2.resourceName")
    };
}

export { ControlInstanceTomlCodec } from "./ConfigTomlInstance.js";
export type * from "./ConfigTomlTypes.js";

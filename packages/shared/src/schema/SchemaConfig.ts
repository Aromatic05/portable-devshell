import type { AuthConfig } from "../config/ConfigAuth.js";
import type { ControllerConfig } from "../config/ConfigController.js";
import type { InstanceConfig } from "../config/ConfigInstance.js";
import type { McpConfig } from "../config/ConfigMcp.js";
import { asInstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import { asWorkspacePath } from "../type/identity/TypeIdentityWorkspacePath.js";

type ParseSuccess<T> = {
    data: T;
    success: true;
};

type ParseFailure = {
    error: Error;
    success: false;
};

type ParseResult<T> = ParseFailure | ParseSuccess<T>;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown, fieldName: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${fieldName} must be a non-empty string`);
    }

    return value;
}

function parseAuthConfig(value: unknown): AuthConfig {
    if (!isRecord(value)) {
        throw new Error("auth must be an object");
    }

    const provider = asNonEmptyString(value.provider, "auth.provider");

    return {
        audience: value.audience === undefined ? undefined : asNonEmptyString(value.audience, "auth.audience"),
        enabled: typeof value.enabled === "boolean" ? value.enabled : fail("auth.enabled must be a boolean"),
        issuer: value.issuer === undefined ? undefined : asNonEmptyString(value.issuer, "auth.issuer"),
        provider
    };
}

function parseMcpConfig(value: unknown): McpConfig {
    if (!isRecord(value)) {
        throw new Error("mcp must be an object");
    }

    return {
        auth: value.auth === undefined ? undefined : parseAuthConfig(value.auth),
        enabled: typeof value.enabled === "boolean" ? value.enabled : fail("mcp.enabled must be a boolean"),
        publicExposure:
            typeof value.publicExposure === "boolean"
                ? value.publicExposure
                : fail("mcp.publicExposure must be a boolean")
    };
}

function parseInstanceConfig(value: unknown): InstanceConfig {
    if (!isRecord(value)) {
        throw new Error("instance must be an object");
    }

    const env = value.env;
    if (env !== undefined) {
        if (!isRecord(env)) {
            throw new Error("instance.env must be an object");
        }

        for (const envValue of Object.values(env)) {
            if (typeof envValue !== "string") {
                throw new Error("instance.env values must be strings");
            }
        }
    }

    return {
        env: env as Record<string, string> | undefined,
        name: asInstanceName(asNonEmptyString(value.name, "instance.name")),
        workspacePath: asWorkspacePath(asNonEmptyString(value.workspacePath, "instance.workspacePath"))
    };
}

function fail(message: string): never {
    throw new Error(message);
}

export const configSchema = {
    parse(value: unknown): ControllerConfig {
        if (!isRecord(value)) {
            throw new Error("controller config must be an object");
        }

        if (!Array.isArray(value.instances)) {
            throw new Error("instances must be an array");
        }

        return {
            auth: value.auth === undefined ? undefined : parseAuthConfig(value.auth),
            instances: value.instances.map(parseInstanceConfig),
            mcp: parseMcpConfig(value.mcp)
        };
    },
    safeParse(value: unknown): ParseResult<ControllerConfig> {
        try {
            return {
                data: this.parse(value),
                success: true
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error : new Error(String(error)),
                success: false
            };
        }
    }
};

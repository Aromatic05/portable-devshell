import { createError, errorCodes } from "@portable-devshell/shared";
import { McpAuthPublicExposureGuard } from "@portable-devshell/mcp";

import type { ControlConfig, ControlInstanceConfig } from "./ControlConfigTomlCodec.js";

export class ControlConfigValidator {
    readonly #publicExposureGuard = new McpAuthPublicExposureGuard();

    validate(config: ControlConfig): ControlConfig {
        try {
            if (config.version !== 1) {
                throw new Error("version must be 1");
            }

            const names = new Set<string>();

            for (const instance of config.instances) {
                this.#validateInstance(instance);

                if (names.has(instance.name)) {
                    throw new Error(`duplicate instance name: ${instance.name}`);
                }

                names.add(instance.name);
            }

            this.#publicExposureGuard.assertSafe({
                auth: toMcpGuardAuth(config.mcp.auth.mode),
                listenHost: config.mcp.listenHost,
                publicBaseUrl: config.mcp.publicBaseUrl
            });

            return config;
        } catch (error) {
            if (isStructuredConfigError(error)) {
                throw error;
            }

            const message = error instanceof Error ? error.message : String(error);
            const fieldPath = readFieldPath(message);
            throw createError({
                code: errorCodes.controlConfigValidationFailed,
                cause: error,
                details: {
                    ...(fieldPath === undefined ? {} : { fieldPath }),
                    phase: "validate"
                },
                message,
                retryable: false
            });
        }
    }

    #validateInstance(instance: ControlInstanceConfig): void {
        if (!instance.name.includes("-")) {
            throw new Error(`instance name must include '-': ${instance.name}`);
        }

        const expectedPath = `/${instance.name}/mcp`;
        if (instance.mcp.path !== undefined && instance.mcp.path !== expectedPath) {
            throw new Error(`instance.mcp.path must be ${expectedPath}`);
        }

        switch (instance.provider) {
            case "local":
                return;
            case "ssh":
                if (instance.host === undefined) {
                    throw new Error(`ssh instance ${instance.name} requires host`);
                }
                return;
            case "docker":
            case "podman":
                if (instance.container === undefined) {
                    throw new Error(`${instance.provider} instance ${instance.name} requires container`);
                }
        }
    }
}

function toMcpGuardAuth(mode: "none" | "oauth2" | "token"): { enabled: boolean; provider: string } | undefined {
    if (mode === "none") {
        return {
            enabled: false,
            provider: "none"
        };
    }

    return {
        enabled: true,
        provider: mode
    };
}

function isStructuredConfigError(error: unknown): error is { code: string } {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}

function readFieldPath(message: string): string | undefined {
    const match = message.match(/^([A-Za-z0-9_.[\]/-]+)\s+/u);
    return match?.[1];
}

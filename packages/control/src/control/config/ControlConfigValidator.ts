import { createError, errorCodes, type InstanceContainerConfig, type InstanceContainerMountConfig } from "@portable-devshell/shared";
import { McpAuthPublicExposureGuard } from "@portable-devshell/mcp";

import type { ControlConfig, ControlInstanceConfig, ControlMcpOAuth2Config } from "./ControlConfigTomlCodec.js";

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
            this.#validateGlobalMcp(config);

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

        if (instance.workspace === undefined) {
            throw new Error(`workspace is required for instance ${instance.name}`);
        }

        const expectedPath = `/${instance.name}/mcp`;
        if (instance.mcp.path !== undefined && instance.mcp.path !== expectedPath) {
            throw new Error(`instance.mcp.path must be ${expectedPath}`);
        }

        switch (instance.provider) {
            case "local":
                if (instance.container !== undefined) {
                    throw new Error(`local instance ${instance.name} does not support container`);
                }
                return;
            case "ssh":
                if (instance.ssh?.command === undefined) {
                    throw new Error(`ssh instance ${instance.name} requires ssh.command`);
                }
                if (instance.container !== undefined) {
                    throw new Error(`ssh instance ${instance.name} does not support container`);
                }
                return;
            case "docker":
            case "podman":
                if (instance.container === undefined) {
                    throw new Error(`${instance.provider} instance ${instance.name} requires container`);
                }
                this.#validateContainer(instance.name, instance.container);
                return;
        }
    }

    #validateContainer(instanceName: string, container: InstanceContainerConfig): void {
        switch (container.mode) {
            case "preset":
                this.#validateManagedContainer(instanceName, container);
                if (container.preset.length === 0) {
                    throw new Error(`container.preset is required for instance ${instanceName}`);
                }
                if (container.image.length === 0) {
                    throw new Error(`container.image is required for instance ${instanceName}`);
                }
                return;
            case "dockerfile":
                this.#validateManagedContainer(instanceName, container);
                if (container.build.context.length === 0) {
                    throw new Error(`container.build.context is required for instance ${instanceName}`);
                }
                return;
            case "compose":
                if (container.compose.file.length === 0) {
                    throw new Error(`container.compose.file is required for instance ${instanceName}`);
                }
                if (container.compose.service.length === 0) {
                    throw new Error(`container.compose.service is required for instance ${instanceName}`);
                }
                return;
            case "existingImage":
                this.#validateManagedContainer(instanceName, container);
                if (container.image.length === 0) {
                    throw new Error(`container.image is required for instance ${instanceName}`);
                }
                return;
            case "existingStoppedContainer":
                if (container.containerName.length === 0) {
                    throw new Error(`container.containerName is required for instance ${instanceName}`);
                }
                return;
        }
    }

    #validateManagedContainer(
        instanceName: string,
        container: Extract<InstanceContainerConfig, { mode: "preset" | "dockerfile" | "existingImage" }>
    ): void {
        if (container.containerName.length === 0) {
            throw new Error(`container.containerName is required for instance ${instanceName}`);
        }

        for (const [index, mount] of (container.mounts ?? []).entries()) {
            this.#validateMount(instanceName, index, mount);
        }

        if (container.env !== undefined) {
            for (const [key, value] of Object.entries(container.env)) {
                if (key.length === 0 || value.length === 0) {
                    throw new Error(`container.env.${key} must be a non-empty string for instance ${instanceName}`);
                }
            }
        }
    }

    #validateMount(instanceName: string, index: number, mount: InstanceContainerMountConfig): void {
        if (mount.source.length === 0) {
            throw new Error(`container.mounts[${index}].source is required for instance ${instanceName}`);
        }

        if (mount.target.length === 0) {
            throw new Error(`container.mounts[${index}].target is required for instance ${instanceName}`);
        }
    }

    #validateGlobalMcp(config: ControlConfig): void {
        if (config.mcp.publicBaseUrl !== undefined) {
            parseUrl(config.mcp.publicBaseUrl, "mcp.publicBaseUrl");
        }

        if (config.mcp.auth.mode !== "oauth2") {
            return;
        }

        if (config.mcp.auth.oauth2 === undefined) {
            throw new Error("mcp.auth.oauth2 is required when mcp.auth.mode=oauth2");
        }

        this.#validateOauth2(config.mcp.auth.oauth2);
    }

    #validateOauth2(config: ControlMcpOAuth2Config): void {
        parseUrl(config.issuer, "mcp.auth.oauth2.issuer");
        parseUrl(config.audience, "mcp.auth.oauth2.audience");

        if (config.documentationUrl !== undefined) {
            parseUrl(config.documentationUrl, "mcp.auth.oauth2.documentationUrl");
        }

        if (config.jwksUri !== undefined) {
            parseUrl(config.jwksUri, "mcp.auth.oauth2.jwksUri");
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

function parseUrl(value: string, fieldPath: string): URL {
    try {
        return new URL(value);
    } catch {
        throw new Error(`${fieldPath} must be a valid URL`);
    }
}

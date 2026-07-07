import { McpAuthPublicExposureGuard } from "@portable-devshell/mcp";

import type { ControlConfig, ControlInstanceConfig } from "./ControlConfigTomlCodec.js";

export class ControlConfigValidator {
    readonly #publicExposureGuard = new McpAuthPublicExposureGuard();

    validate(config: ControlConfig): ControlConfig {
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

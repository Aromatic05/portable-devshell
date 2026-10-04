import {
    createRemoteError,
    controlErrorCodes,
    type ControlConfig,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "@portable-devshell/core";

import { ReverseConnectionGateway } from "../../transport/channel/reverse/Gateway.js";
import { ReverseCredentialService } from "@portable-devshell/core";
import { ReverseCredentialStore } from "@portable-devshell/core";

interface ConnectionLifecyclePort {
    registerInstanceDeleteRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
    registerInstanceDisableRetirement(
        retire: (instance: ControlConfig["instances"][number]) => Promise<void>,
    ): () => void;
}

interface ConnectionMcpPort {
    readonly instanceEditor: ConnectionLifecyclePort;
    readonly host?: {
        readonly server: Parameters<ReverseConnectionGateway["install"]>[0];
    };
}

interface ConnectionStatePort {
    readonly homeDirectory?: string;
    readonly instances: InstanceRegistry;
    requireConfig(): ControlConfig;
}

export interface ConnectionModuleOptions {
    mcp: ConnectionMcpPort;
    state: ConnectionStatePort;
}

export class ConnectionModule {
    readonly service?: ReverseCredentialService;
    readonly #gateway?: ReverseConnectionGateway;

    constructor(options: ConnectionModuleOptions) {
        const config = options.state.requireConfig();
        const hasReverseInstance = config.instances.some(
            (instance) => instance.provider === "reverse",
        );
        if (
            options.mcp.host === undefined ||
            config.mcp.publicBaseUrl === undefined
        ) {
            if (!hasReverseInstance) return;
            throw createRemoteError({
                code: controlErrorCodes.configValidationFailed,
                message:
                    "Reverse instances require enabled MCP HTTP host and mcp.publicBaseUrl.",
                retryable: false,
            });
        }
        const credentialStore = new ReverseCredentialStore(
            options.state.homeDirectory,
        );
        this.service = new ReverseCredentialService({
            credentialStore,
            instanceRegistry: options.state.instances,
            publicBaseUrl: config.mcp.publicBaseUrl,
        });
        this.#gateway = new ReverseConnectionGateway({
            credentialStore,
            instanceRegistry: options.state.instances,
            publicBaseUrl: config.mcp.publicBaseUrl,
        });
        this.install(options.mcp.host.server);
        this.service.setDisconnectHandler((instance) =>
            this.#gateway?.disconnect(instance),
        );
        options.mcp.instanceEditor.registerInstanceDeleteRetirement(
            async (instance) => {
                if (instance.provider !== "reverse") return;
                await this.service?.retireInstance(instance.name);
            },
        );
        options.mcp.instanceEditor.registerInstanceDisableRetirement(
            async (instance) => {
                if (instance.provider !== "reverse") return;
                await this.service?.retireInstance(instance.name);
            },
        );
    }

    stop(): void {
        this.#gateway?.stop();
    }

    install(
        server: Parameters<ReverseConnectionGateway["install"]>[0],
        publicBaseUrl?: string,
    ): void {
        if (publicBaseUrl !== undefined) {
            this.service?.setPublicBaseUrl(publicBaseUrl);
            this.#gateway?.setPublicBaseUrl(publicBaseUrl);
        }
        this.#gateway?.install(server);
    }
}

import {
    createRemoteError,
    controlErrorCodes,
    type ControlConfig,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "../../../../Registry.js";

import { ReverseIngress } from "./Ingress.js";
import { ReverseCredentials } from "./credential/Credentials.js";
import { ReverseCredentialStore } from "./credential/Store.js";

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
        readonly server: Parameters<ReverseIngress["install"]>[0];
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
    readonly service?: ReverseCredentials;
    readonly #gateway?: ReverseIngress;

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
        this.service = new ReverseCredentials({
            credentialStore,
            instanceRegistry: options.state.instances,
            publicBaseUrl: config.mcp.publicBaseUrl,
        });
        this.#gateway = new ReverseIngress({
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
        server: Parameters<ReverseIngress["install"]>[0],
        publicBaseUrl?: string,
    ): void {
        if (publicBaseUrl !== undefined) {
            this.service?.setPublicBaseUrl(publicBaseUrl);
            this.#gateway?.setPublicBaseUrl(publicBaseUrl);
        }
        this.#gateway?.install(server);
    }
}

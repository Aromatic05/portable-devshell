import type { ConnectionModuleOptions } from "./Api.js";
import { createRemoteError, controlErrorCodes } from "@portable-devshell/shared";

import { ReverseIngress } from "./Ingress.js";
import { ReverseCredentials } from "./credential/Credentials.js";
import { ReverseCredentialStore } from "./credential/Store.js";

export class ConnectionModule {
    readonly service?: ReverseCredentials;
    readonly #gateway?: ReverseIngress;

    constructor(options: ConnectionModuleOptions) {
        if (options.host === undefined || options.publicBaseUrl === undefined) {
            if (!options.hasReverseInstance) return;
            throw createRemoteError({
                code: controlErrorCodes.configValidationFailed,
                message:
                    "Reverse instances require enabled MCP HTTP host and mcp.publicBaseUrl.",
                retryable: false,
            });
        }
        const credentialStore = new ReverseCredentialStore(
            options.homeDirectory,
        );
        this.service = new ReverseCredentials({
            credentialStore,
            instanceRegistry: options.instances,
            publicBaseUrl: options.publicBaseUrl,
        });
        this.#gateway = new ReverseIngress({
            credentialStore,
            instanceRegistry: options.instances,
            publicBaseUrl: options.publicBaseUrl,
        });
        this.install(options.host);
        this.service.setDisconnectHandler((instance) =>
            this.#gateway?.disconnect(instance),
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

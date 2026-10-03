import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";

import { ReverseConnectionGateway } from "./Gateway.js";
import { ReverseCredentialService } from "./credential/Service.js";
import { ReverseCredentialStore } from "./credential/Store.js";
import type { ControlRuntimeState } from "../composition/control/State.js";
import type { McpControlModule } from "../composition/mcp/Control.js";

export interface ConnectionModuleOptions {
    mcp: McpControlModule;
    state: ControlRuntimeState;
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
        options.mcp.configEditor.registerInstanceDeleteRetirement(
            async (instance) => {
                if (instance.provider !== "reverse") return;
                await this.service?.retireInstance(instance.name);
            },
        );
        options.mcp.configEditor.registerInstanceDisableRetirement(
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

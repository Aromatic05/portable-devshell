import { createError, errorCodes } from "@portable-devshell/shared";

import { ReverseConnectionGateway } from "../../control/reverse/connection/ReverseConnectionGateway.js";
import { ReverseCredentialService } from "../../control/reverse/credential/ReverseCredentialService.js";
import { ReverseCredentialStore } from "../../control/reverse/credential/ReverseCredentialStore.js";
import type { ControlRuntimeState } from "./ControlRuntimeState.js";
import type { ControlRuntimeMcp } from "./ControlRuntimeMcp.js";

export interface ControlRuntimeReverseOptions {
    mcp: ControlRuntimeMcp;
    state: ControlRuntimeState;
}

export class ControlRuntimeReverse {
    readonly service?: ReverseCredentialService;
    readonly #gateway?: ReverseConnectionGateway;

    constructor(options: ControlRuntimeReverseOptions) {
        const config = options.state.requireConfig();
        const hasReverseInstance = config.instances.some((instance) => instance.provider === "reverse");
        if (options.mcp.host === undefined || config.mcp.publicBaseUrl === undefined) {
            if (!hasReverseInstance) return;
            throw createError({
                code: errorCodes.controlConfigValidationFailed,
                message: "Reverse instances require enabled MCP HTTP host and mcp.publicBaseUrl.",
                retryable: false
            });
        }
        const credentialStore = new ReverseCredentialStore(options.state.homeDirectory);
        this.service = new ReverseCredentialService({
            credentialStore,
            instanceRegistry: options.state.instances,
            publicBaseUrl: config.mcp.publicBaseUrl
        });
        this.#gateway = new ReverseConnectionGateway({
            credentialStore,
            instanceRegistry: options.state.instances,
            publicBaseUrl: config.mcp.publicBaseUrl
        });
        this.install(options.mcp.host.server);
        this.service.setDisconnectHandler((instance) => this.#gateway?.disconnect(instance));
        options.mcp.configEditor.registerInstanceDeleteRetirement(async (instance) => {
            if (instance.provider !== "reverse") return;
            await this.service?.retireInstance(instance.name);
        });
    }

    stop(): void {
        this.#gateway?.stop();
    }

    install(
        server: Parameters<ReverseConnectionGateway["install"]>[0],
        publicBaseUrl?: string
    ): void {
        if (publicBaseUrl !== undefined) {
            this.service?.setPublicBaseUrl(publicBaseUrl);
            this.#gateway?.setPublicBaseUrl(publicBaseUrl);
        }
        this.#gateway?.install(server);
    }
}

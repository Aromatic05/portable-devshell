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
        if (!config.instances.some((instance) => instance.provider === "reverse")) return;
        if (options.mcp.host === undefined || config.mcp.publicBaseUrl === undefined) {
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
        this.#gateway.install(options.mcp.host.server);
        this.service.setDisconnectHandler((instance) => this.#gateway?.disconnect(instance));
    }

    stop(): void {
        this.#gateway?.stop();
    }
}

import { createError, errorCodes } from "@portable-devshell/shared";

import { ReverseConnectionGateway } from "../../modules/reverse/ReverseConnectionGateway.js";
import { ReverseControlService } from "../../modules/reverse/ReverseControlService.js";
import { ReverseCredentialStore } from "../../modules/reverse/ReverseCredentialStore.js";
import type { ControlState } from "./ControlState.js";
import type { McpRuntime } from "./McpRuntime.js";

export interface ReverseRuntimeOptions {
    mcp: McpRuntime;
    state: ControlState;
}

export class ReverseRuntime {
    readonly service?: ReverseControlService;
    readonly #gateway?: ReverseConnectionGateway;

    constructor(options: ReverseRuntimeOptions) {
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
        this.service = new ReverseControlService({
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

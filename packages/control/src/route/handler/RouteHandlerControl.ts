import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { ControlInstanceCreateService } from "../../control/ControlInstanceCreateService.js";
import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";

export interface RouteHandlerControlOptions {
    instanceCreateService?: ControlInstanceCreateService;
    instanceRegistry: InstanceRegistry;
}

export class RouteHandlerControl {
    readonly #instanceCreateService?: ControlInstanceCreateService;
    readonly #instanceRegistry: InstanceRegistry;

    constructor(options: RouteHandlerControlOptions) {
        this.#instanceCreateService = options.instanceCreateService;
        this.#instanceRegistry = options.instanceRegistry;
    }

    async handle(method: string, params?: JsonValue): Promise<JsonValue> {
        switch (method) {
            case "control.ping":
                return { pong: true };
            case "control.status":
                return {
                    instanceCount: this.#instanceRegistry.list().length,
                    ok: true
                };
            case "control.shutdown":
                return { accepted: true };
            case "control.listInstances":
                return this.#instanceRegistry.list().map((descriptor) => ({
                    mcpEnabled: descriptor.mcpEnabled,
                    name: descriptor.name,
                    snapshot: descriptor.worker.snapshot()
                })) as unknown as JsonValue;
            case "control.getInstanceCreateSchema":
                return this.#requireInstanceCreateService().getSchema() as unknown as JsonValue;
            case "control.validateInstanceCreateDraft":
                return this.#requireInstanceCreateService().validateDraft(params) as unknown as JsonValue;
            case "control.createInstance":
                return (await this.#requireInstanceCreateService().createInstance(params)) as unknown as JsonValue;
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }

    #requireInstanceCreateService(): ControlInstanceCreateService {
        if (this.#instanceCreateService !== undefined) {
            return this.#instanceCreateService;
        }

        throw createError({
            code: errorCodes.envelopeInvalid,
            message: "Instance creation is not available.",
            retryable: false
        });
    }
}

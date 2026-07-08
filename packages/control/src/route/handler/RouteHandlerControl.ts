import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";

export interface RouteHandlerControlOptions {
    instanceRegistry: InstanceRegistry;
}

export class RouteHandlerControl {
    readonly #instanceRegistry: InstanceRegistry;

    constructor(options: RouteHandlerControlOptions) {
        this.#instanceRegistry = options.instanceRegistry;
    }

    async handle(method: string): Promise<JsonValue> {
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
            default:
                throw createError({
                    code: errorCodes.envelopeInvalid,
                    message: `Method ${method} was not found.`,
                    retryable: false
                });
        }
    }
}

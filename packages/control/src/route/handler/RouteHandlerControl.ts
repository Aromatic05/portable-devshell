import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { ControlInstanceCreateService } from "../../control/ControlInstanceCreateService.js";
import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";
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

    async handle(connection: ControlRpcConnection, method: string, params?: JsonValue): Promise<JsonValue> {
        switch (method) {
            case "control.identifyClient": {
                const clientKind = readDeclaredClientKind(params);

                if (connection.clientKind !== "unknown" && connection.clientKind !== clientKind) {
                    throw createError({
                        code: errorCodes.controlClientIdentityInvalid,
                        message: `Connection is already identified as ${connection.clientKind}.`,
                        retryable: false
                    });
                }

                connection.identifyClient(clientKind);
                return { clientKind, ok: true };
            }
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

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readDeclaredClientKind(params?: JsonValue): "cli" | "tui" {
    if (!isRecord(params)) {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: "control.identifyClient requires clientKind.",
            retryable: false
        });
    }

    if (params.clientKind === "cli" || params.clientKind === "tui") {
        return params.clientKind;
    }

    if (params.clientKind === "mcp") {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: "MCP client identity is assigned by the MCP endpoint, not control RPC.",
            retryable: false
        });
    }

    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "control.identifyClient requires clientKind to be cli or tui.",
        retryable: false
    });
}

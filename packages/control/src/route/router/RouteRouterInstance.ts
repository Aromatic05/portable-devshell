import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { RpcRequestEnvelope } from "../../control/rpc/ControlRpcConnection.js";
import type { RouteTarget } from "../RouteTarget.js";
import { RouteHandlerInstance } from "../handler/RouteHandlerInstance.js";
import type { ControlRpcConnection } from "../../control/rpc/ControlRpcConnection.js";

export class RouteRouterInstance {
    readonly #handler: RouteHandlerInstance;

    constructor(handler: RouteHandlerInstance) {
        this.#handler = handler;
    }

    async route(connection: ControlRpcConnection, request: RpcRequestEnvelope): Promise<JsonValue> {
        const target = request.target as RouteTarget;

        if (target.kind !== "instance") {
            throw createError({
                code: errorCodes.targetInvalid,
                message: "Request target must be an instance target.",
                retryable: false
            });
        }

        return await this.#handler.handle(connection, request.method, request.id, target.instance, request.params);
    }
}

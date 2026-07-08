import { createError, errorCodes, type JsonValue } from "@portable-devshell/shared";

import type { RpcRequestEnvelope } from "../../control/rpc/ControlRpcConnection.js";
import { RouteHandlerControl } from "../handler/RouteHandlerControl.js";

export class RouteRouterControl {
    readonly #handler: RouteHandlerControl;

    constructor(handler: RouteHandlerControl) {
        this.#handler = handler;
    }

    async route(request: RpcRequestEnvelope): Promise<JsonValue> {
        if (request.target.kind !== "control") {
            throw createError({
                code: errorCodes.targetInvalid,
                message: "Request target must be a control target.",
                retryable: false
            });
        }

        return await this.#handler.handle(request.method, request.params);
    }
}

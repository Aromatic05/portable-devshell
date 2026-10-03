import type {
    ControlPortDefinition,
    JsonValue,
} from "@portable-devshell/shared";

import { routeModule } from "../server/Route.js";
import { negotiateControlProtocol } from "./Protocol.js";

export interface ServiceRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceRouteModule(
    options: ServiceRouteModuleOptions,
): ControlPortDefinition {
    return routeModule("service", {
        hello: (request, context) =>
            negotiateControlProtocol(
                request.payload,
                context.peer,
            ) as unknown as JsonValue,
        ping: () => ({ pong: true }),
        status: () => ({
            instanceCount: options.instanceCount(),
            ok: true,
            pid: process.pid,
        }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined)
                context.afterReply(options.restart);
            return { accepted: true };
        },
    });
}

import type { PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { routeModule } from "../../common/RouteModule.js";

export interface ServiceModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceModule(options: ServiceModuleOptions): PrefixRouteModuleDefinition {
    return routeModule("service", {
        ping: () => ({ pong: true }),
        status: () => ({ instanceCount: options.instanceCount(), ok: true }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined) {
                context.afterReply(options.restart);
            }
            return { accepted: true };
        }
    });
}

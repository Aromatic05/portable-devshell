import type { PrefixRouteModuleDefinition } from "@portable-devshell/shared";

import { routeModule } from "../../route/ControlRouteFactory.js";

export interface ServiceRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceRouteModule(options: ServiceRouteModuleOptions): PrefixRouteModuleDefinition {
    return routeModule("service", {
        ping: () => ({ pong: true }),
        status: () => ({ instanceCount: options.instanceCount(), ok: true, pid: process.pid }),
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

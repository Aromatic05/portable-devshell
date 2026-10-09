import type { ControlConfig } from "@portable-devshell/shared";

import type { ConfigRuntimeChangeSet } from "../config/engine/Api.js";
import type { McpControlModule } from "./mcp/Module.js";
import type {
    ControlWebRuntime,
    ControlWebTransportPort,
} from "./web/Runtime.js";

export interface ControlServerConfigOptions {
    mcp: McpControlModule;
    replaceHttpRoutes(config: ControlConfig): Promise<void>;
    transport: ControlWebTransportPort;
    web: ControlWebRuntime;
}

export class ControlServerConfig {
    readonly #mcp: McpControlModule;
    readonly #replaceHttpRoutes: (config: ControlConfig) => Promise<void>;
    readonly #transport: ControlWebTransportPort;
    readonly #web: ControlWebRuntime;

    constructor(options: ControlServerConfigOptions) {
        this.#mcp = options.mcp;
        this.#replaceHttpRoutes = options.replaceHttpRoutes;
        this.#transport = options.transport;
        this.#web = options.web;
    }

    async apply(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<boolean> {
        if (changes.instanceAuth && !changes.mcp && !changes.web) return true;

        if (
            changes.web &&
            !changes.mcp &&
            previous.web.enabled &&
            next.web.enabled &&
            endpointIsIndependent(
                previous.web,
                previous.mcp,
                previous.mcp.enabled,
            ) &&
            endpointIsIndependent(next.web, next.mcp, next.mcp.enabled)
        ) {
            await this.#web.replace(previous, next, this.#transport);
            return true;
        }
        if (
            changes.mcp &&
            !changes.web &&
            endpointIsIndependent(
                previous.mcp,
                previous.web,
                previous.web.enabled,
            ) &&
            endpointIsIndependent(next.mcp, next.web, next.web.enabled)
        ) {
            await this.#replaceMcp(previous, next);
            return true;
        }
        return false;
    }

    async #replaceMcp(previous: ControlConfig, next: ControlConfig): Promise<void> {
        const retired = await this.#mcp.replaceMcpHost(previous, next);
        try {
            await this.#replaceHttpRoutes(next);
            if (retired !== undefined) await this.#mcp.stopHost(retired);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            await this.#mcp
                .restoreMcpHost(retired, previous)
                .catch((rollbackError) => rollbackFailures.push(rollbackError));
            await this.#replaceHttpRoutes(previous)
                .catch((rollbackError) => rollbackFailures.push(rollbackError));
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "MCP hot replacement failed and runtime rollback was incomplete.",
                );
            }
            throw error;
        }
        if (retired !== undefined && retired !== this.#mcp.host && "dispose" in retired &&
            typeof retired.dispose === "function")
            await retired.dispose();
    }
}

function endpointIsIndependent(
    endpoint: { listenHost: string; listenPort: number },
    other: { listenHost: string; listenPort: number },
    otherEnabled: boolean,
): boolean {
    return !otherEnabled || !sameEndpoint(endpoint, other);
}

function sameEndpoint(
    left: { listenHost: string; listenPort: number },
    right: { listenHost: string; listenPort: number },
): boolean {
    return (
        left.listenHost === right.listenHost &&
        left.listenPort === right.listenPort
    );
}

import { controlWebBasePath } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import { OperationalOverviewService } from "../../control/overview/OperationalOverviewService.js";
import { ControlChannelServer, type ControlChannelProvider } from "../../server/channel/ControlChannelServer.js";
import { ControlSocketChannelProvider } from "../../server/socket/ControlSocketChannelProvider.js";
import { resolveControlWebAssetsDirectory } from "../../server/web/ControlWebAssets.js";
import { ControlWebSessionService } from "../../server/web/ControlWebSessionService.js";
import { ControlWebSocketChannelProvider } from "../../server/web/ControlWebSocketChannelProvider.js";
import { ControlRouteComposition } from "../ControlRouteComposition.js";
import type { ControlRuntimeArtifact } from "./ControlRuntimeArtifact.js";
import type { ControlRuntimeMcp } from "./ControlRuntimeMcp.js";
import type { ControlRuntimeReverse } from "./ControlRuntimeReverse.js";

export interface ControlRuntimeOptions {
    artifact: ControlRuntimeArtifact;
    instances: InstanceRegistry;
    mcp: ControlRuntimeMcp;
    restart: () => Promise<void>;
    reverse: ControlRuntimeReverse;
    shutdown: () => Promise<void>;
    socketPath: string;
}

export class ControlRuntime {
    readonly #artifact: ControlRuntimeArtifact;
    readonly #channels: ControlChannelServer;
    readonly #instances: InstanceRegistry;
    readonly #mcp: ControlRuntimeMcp;
    readonly #reverse: ControlRuntimeReverse;
    readonly #routes: ControlRouteComposition;
    readonly #socketProvider: ControlSocketChannelProvider;

    constructor(options: ControlRuntimeOptions) {
        this.#artifact = options.artifact;
        this.#instances = options.instances;
        this.#mcp = options.mcp;
        this.#reverse = options.reverse;
        this.#routes = new ControlRouteComposition({
            artifact: options.artifact.service,
            config: options.mcp.configEditor,
            instanceCreate: options.mcp.instanceCreate,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            overview: new OperationalOverviewService({
                instances: options.instances,
                oauthApprovals: () => options.mcp.oauthApprovals
            }),
            restart: options.restart,
            reverse: options.reverse.service,
            shutdown: options.shutdown
        });
        this.#socketProvider = new ControlSocketChannelProvider({ socketPath: options.socketPath });
        const providers: ControlChannelProvider[] = [this.#socketProvider];
        const http = options.mcp.webHost;
        if (http !== undefined && options.mcp.webEnabled) {
            const basePath = controlWebBasePath(options.mcp.webPublicBaseUrl);
            providers.push(new ControlWebSocketChannelProvider({
                assetDirectory: resolveControlWebAssetsDirectory(),
                basePath,
                http,
                sessions: new ControlWebSessionService({
                    basePath,
                    secureCookie: options.mcp.webPublicBaseUrl?.startsWith("https://") ?? false
                })
            }));
        }
        this.#channels = new ControlChannelServer({ providers, routes: this.#routes });
    }

    async start(): Promise<void> {
        try {
            await this.#mcp.start();
            await this.#channels.start();
        } catch (error) {
            await this.stop().catch(() => undefined);
            throw error;
        }
    }

    async stop(): Promise<void> {
        const failures: unknown[] = [];
        await this.#channels.close().catch((error) => failures.push(error));
        try {
            this.#reverse.stop();
        } catch (error) {
            failures.push(error);
        }
        await this.#mcp.stop().catch((error) => failures.push(error));
        await this.#artifact.stop().catch((error) => failures.push(error));
        await this.#instances.stopOwned().catch((error) => failures.push(error));
        try {
            this.#routes.dispose();
        } catch (error) {
            failures.push(error);
        }
        await this.#socketProvider.removeEndpoint().catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(failures, "Control runtime failed to stop cleanly.");
        }
    }
}

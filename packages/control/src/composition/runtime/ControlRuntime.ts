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
    #webProvider?: ControlWebSocketChannelProvider;

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
        const webProvider = this.#createWebProvider();
        if (webProvider !== undefined) providers.push(webProvider);
        this.#webProvider = webProvider;
        this.#channels = new ControlChannelServer({ providers, routes: this.#routes });
        this.#mcp.setWebConfigApplier?.(async (previous, next) => await this.#replaceWebProvider(previous, next));
        this.#mcp.setMcpConfigApplier?.(async (_previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined) this.#reverse.install(host.server);
                await retired?.stop();
            } catch (error) {
                await this.#mcp.restoreMcpHost(retired);
                throw error;
            }
        });
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

    #createWebProvider(): ControlWebSocketChannelProvider | undefined {
        const http = this.#mcp.webHost;
        if (http === undefined || !this.#mcp.webEnabled) return undefined;
        const basePath = controlWebBasePath(this.#mcp.webPublicBaseUrl);
        return new ControlWebSocketChannelProvider({
            assetDirectory: resolveControlWebAssetsDirectory(),
            basePath,
            http,
            sessions: new ControlWebSessionService({
                basePath,
                secureCookie: this.#mcp.webPublicBaseUrl?.startsWith("https://") ?? false
            })
        });
    }

    async #replaceWebProvider(
        previousConfig: import("@portable-devshell/shared").ControlConfig,
        nextConfig: import("@portable-devshell/shared").ControlConfig
    ): Promise<void> {
        const previousHost = await this.#mcp.replaceWebHost(nextConfig);
        const previousProvider = this.#webProvider;
        const nextProvider = this.#createWebProvider();
        if (previousProvider === undefined || nextProvider === undefined) {
            throw new Error("Web listener hot replacement requires Web to remain enabled.");
        }
        try {
            await this.#channels.replaceProvider(previousProvider, nextProvider);
            this.#webProvider = nextProvider;
            await this.#mcp.stopRetiredWebHost(previousHost);
        } catch (error) {
            await this.#mcp.restoreWebHost(previousHost, previousConfig);
            throw error;
        }
    }
}

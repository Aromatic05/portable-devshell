import { controlWebBasePath } from "@portable-devshell/shared";

import { McpOAuthProtectedResource, type HttpHost } from "@portable-devshell/mcp";
import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import { OperationalOverviewService } from "../../control/overview/OperationalOverviewService.js";
import { ControlChannelServer, type ControlChannelProvider } from "../../server/channel/ControlChannelServer.js";
import { ControlSocketChannelProvider } from "../../server/socket/ControlSocketChannelProvider.js";
import { resolveControlWebAssetsDirectory } from "../../server/web/ControlWebAssets.js";
import { ControlWebOAuthFlow } from "../../server/web/ControlWebOAuthFlow.js";
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

interface ControlWebRuntime {
    flow?: ControlWebOAuthFlow;
    host: HttpHost;
    provider: ControlWebSocketChannelProvider;
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
    #webFlow?: ControlWebOAuthFlow;
    #webFlowUninstall?: () => void;

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
        const webRuntime = this.#createWebRuntime();
        if (webRuntime !== undefined) providers.push(webRuntime.provider);
        this.#webProvider = webRuntime?.provider;
        this.#webFlow = webRuntime?.flow;
        this.#channels = new ControlChannelServer({ providers, routes: this.#routes });
        this.#mcp.setWebConfigApplier?.(async (previous, next) => await this.#replaceWebProvider(previous, next));
        this.#mcp.setMcpConfigApplier?.(async (_previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined) this.#reverse.install(host.server, next.mcp.publicBaseUrl);
                await retired?.stop();
            } catch (error) {
                await this.#mcp.restoreMcpHost(retired);
                const host = this.#mcp.host;
                if (host !== undefined) this.#reverse.install(host.server, _previous.mcp.publicBaseUrl);
                throw error;
            }
        });
    }

    async start(): Promise<void> {
        try {
            await this.#webFlow?.warmup();
            const webHost = this.#mcp.webHost;
            if (this.#webFlow !== undefined && webHost !== undefined) {
                this.#webFlowUninstall = this.#webFlow.install(webHost);
            }
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
        this.#webFlowUninstall?.();
        this.#webFlow = undefined;
        this.#webFlowUninstall = undefined;
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

    #createWebRuntime(): ControlWebRuntime | undefined {
        const http = this.#mcp.webHost;
        if (http === undefined || !this.#mcp.webEnabled) return undefined;
        const basePath = controlWebBasePath(this.#mcp.webPublicBaseUrl);
        const secureCookie = this.#mcp.webPublicBaseUrl?.startsWith("https://") ?? false;
        const sessions = new ControlWebSessionService({
            auth: this.#mcp.webAuth,
            basePath,
            secureCookie
        });
        const flow = this.#createWebOAuthFlow(http, basePath, secureCookie, sessions);
        return {
            ...(flow === undefined ? {} : { flow }),
            host: http,
            provider: new ControlWebSocketChannelProvider({
                assetDirectory: resolveControlWebAssetsDirectory(),
                basePath,
                http,
                sessions
            })
        };
    }

    #createWebOAuthFlow(
        http: HttpHost,
        basePath: string,
        secureCookie: boolean,
        sessions: ControlWebSessionService
    ): ControlWebOAuthFlow | undefined {
        const auth = this.#mcp.webAuth;
        const publicBaseUrl = this.#mcp.webPublicBaseUrl;
        if (auth.mode !== "oauth2" || publicBaseUrl === undefined) return undefined;

        const mcpHost = this.#mcp.host;
        const reused = sameOrigin(publicBaseUrl, this.#mcp.publicBaseUrl)
            ? mcpHost?.oauthProtectedResource
            : undefined;
        const providerConfig = {
            documentationUrl: auth.oauth2.documentationUrl,
            requiredScopes: [...auth.oauth2.requiredScopes],
            resourceName: auth.oauth2.resourceName
        };
        const protectedResource = reused ?? new McpOAuthProtectedResource(
            providerConfig,
            new URL(publicBaseUrl).origin,
            this.#mcp.webOauthDir,
            { trustProxy: isLoopbackPublicBaseUrl(publicBaseUrl) }
        );

        return new ControlWebOAuthFlow({
            basePath,
            config: providerConfig,
            installProvider: reused === undefined || http !== mcpHost?.server,
            ownsProvider: reused === undefined,
            protectedResource,
            publicBaseUrl,
            secureCookie,
            sessions
        });
    }

    async #replaceWebProvider(
        previousConfig: import("@portable-devshell/shared").ControlConfig,
        nextConfig: import("@portable-devshell/shared").ControlConfig
    ): Promise<void> {
        const previousHost = await this.#mcp.replaceWebHost(previousConfig, nextConfig);
        const previousProvider = this.#webProvider;
        const previousFlow = this.#webFlow;
        const previousFlowUninstall = this.#webFlowUninstall;
        let previousFlowRemoved = false;
        let nextRuntime: ControlWebRuntime | undefined;
        let nextFlowUninstall: (() => void) | undefined;
        try {
            nextRuntime = this.#createWebRuntime();
            if (previousProvider === undefined || nextRuntime === undefined) {
                throw new Error("Web listener hot replacement requires Web to remain enabled.");
            }
            await nextRuntime.flow?.warmup();
            if (previousFlowUninstall !== undefined) {
                previousFlowUninstall();
                previousFlowRemoved = true;
            }
            nextFlowUninstall = nextRuntime.flow?.install(nextRuntime.host);
            await this.#channels.replaceProvider(previousProvider, nextRuntime.provider);
            this.#webProvider = nextRuntime.provider;
            this.#webFlow = nextRuntime.flow;
            this.#webFlowUninstall = nextFlowUninstall;
            await this.#mcp.stopRetiredWebHost(previousHost).catch(reportRetiredWebHostFailure);
        } catch (error) {
            nextFlowUninstall?.();
            await nextRuntime?.provider.close().catch(() => undefined);
            await this.#mcp.restoreWebHost(previousHost, previousConfig);
            this.#webProvider = previousProvider;
            this.#webFlow = previousFlow;
            if (previousFlowRemoved && previousFlow !== undefined && this.#mcp.webHost !== undefined) {
                await previousFlow.warmup();
                this.#webFlowUninstall = previousFlow.install(this.#mcp.webHost);
            } else {
                this.#webFlowUninstall = previousFlowUninstall;
            }
            throw error;
        }
    }
}

function isLoopbackPublicBaseUrl(publicBaseUrl: string): boolean {
    try {
        const host = new URL(publicBaseUrl).hostname;
        return host === "127.0.0.1" || host === "::1" || host === "localhost";
    } catch {
        return false;
    }
}

function sameOrigin(left: string | undefined, right: string | undefined): boolean {
    if (left === undefined || right === undefined) return false;
    try {
        return new URL(left).origin === new URL(right).origin;
    } catch {
        return false;
    }
}

function reportRetiredWebHostFailure(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}

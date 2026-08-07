import { join } from "node:path";

import { controlRemoteRpcPath, controlWebBasePath } from "@portable-devshell/shared";

import { McpOAuthProtectedResource, type HttpHost } from "@portable-devshell/mcp";
import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import { OperationalOverviewService } from "../../control/overview/OperationalOverviewService.js";
import { ControlChannelServer, type ControlChannelListener } from "../../server/channel/ControlChannelServer.js";
import { ControlSocketListener } from "../../server/socket/ControlSocketListener.js";
import { resolveControlWebAssetsDirectory } from "../../server/web/ControlWebAssets.js";
import { ControlWebOAuthFlow } from "../../server/web/ControlWebOAuthFlow.js";
import { ControlWebSessionService } from "../../server/web/ControlWebSessionService.js";
import { ControlWebSocketAccessService } from "../../server/web/ControlWebSocketAccessService.js";
import { ControlWebSocketListener } from "../../server/web/ControlWebSocketListener.js";
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
    listener: ControlWebSocketListener;
}

export class ControlRuntime {
    readonly #artifact: ControlRuntimeArtifact;
    readonly #channels: ControlChannelServer;
    readonly #instances: InstanceRegistry;
    readonly #mcp: ControlRuntimeMcp;
    readonly #reverse: ControlRuntimeReverse;
    readonly #routes: ControlRouteComposition;
    readonly #socketListener: ControlSocketListener;
    #webListener?: ControlWebSocketListener;
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
            contextAdmin: () => options.mcp.host?.contextRegistry,
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
        this.#socketListener = new ControlSocketListener({ socketPath: options.socketPath });
        const listeners: ControlChannelListener[] = [this.#socketListener];
        const webRuntime = this.#createWebRuntime();
        if (webRuntime !== undefined) listeners.push(webRuntime.listener);
        this.#webListener = webRuntime?.listener;
        this.#webFlow = webRuntime?.flow;
        this.#channels = new ControlChannelServer({ listeners, routes: this.#routes });
        this.#mcp.setWebConfigApplier?.(async (previous, next) => await this.#replaceWebListener(previous, next));
        this.#mcp.setMcpConfigApplier?.(async (_previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(_previous, next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined) this.#reverse.install(host.server, next.mcp.publicBaseUrl);
                await retired?.stop();
            } catch (error) {
                await this.#mcp.restoreMcpHost(retired, _previous);
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
        await this.#socketListener.removeEndpoint().catch((error) => failures.push(error));
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
        const access = new ControlWebSocketAccessService({
            sessions,
            ...(flow === undefined
                ? {}
                : { verifyBearer: async (token: string) => await flow.verifyAccessToken(token) })
        });
        return {
            ...(flow === undefined ? {} : { flow }),
            host: http,
            listener: new ControlWebSocketListener({
                access,
                assetDirectory: resolveControlWebAssetsDirectory(),
                basePath,
                http,
                remotePath: controlRemoteRpcPath(this.#mcp.webPublicBaseUrl),
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
            clientStateFile: join(this.#mcp.webOauthDir, "client.json"),
            config: providerConfig,
            installProvider: reused === undefined || http !== mcpHost?.server,
            ownsProvider: reused === undefined,
            protectedResource,
            publicBaseUrl,
            secureCookie,
            sessions
        });
    }

    async #replaceWebListener(
        previousConfig: import("@portable-devshell/shared").ControlConfig,
        nextConfig: import("@portable-devshell/shared").ControlConfig
    ): Promise<void> {
        const previousHost = await this.#mcp.replaceWebHost(previousConfig, nextConfig);
        const previousListener = this.#webListener;
        const previousFlow = this.#webFlow;
        const previousFlowUninstall = this.#webFlowUninstall;
        let previousFlowRemoved = false;
        let nextRuntime: ControlWebRuntime | undefined;
        let nextFlowUninstall: (() => void) | undefined;
        try {
            nextRuntime = this.#createWebRuntime();
            if (previousListener === undefined || nextRuntime === undefined) {
                throw new Error("Web listener hot replacement requires Web to remain enabled.");
            }
            await nextRuntime.flow?.warmup();
            if (previousFlowUninstall !== undefined) {
                previousFlowUninstall();
                previousFlowRemoved = true;
            }
            nextFlowUninstall = nextRuntime.flow?.install(nextRuntime.host);
            await this.#channels.replaceListener(previousListener, nextRuntime.listener);
            this.#webListener = nextRuntime.listener;
            this.#webFlow = nextRuntime.flow;
            this.#webFlowUninstall = nextFlowUninstall;
            await this.#mcp.stopRetiredWebHost(previousHost).catch(reportRetiredWebHostFailure);
        } catch (error) {
            nextFlowUninstall?.();
            await this.#mcp.restoreWebHost(previousHost, previousConfig);
            this.#webListener = previousListener;
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

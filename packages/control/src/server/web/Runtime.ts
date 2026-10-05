import { join } from "node:path";

import {
    McpOAuthProtectedResource,
    type HttpHost,
    type McpHost,
} from "@portable-devshell/mcp";
import {
    controlRemoteRpcPath,
    controlWebBasePath,
    type ControlConfig,
    type ControlWebAuthConfig,
} from "@portable-devshell/shared";

import type { ExtensionHost } from "../../extension/host/Host.js";
import type { ExtensionPathLayout } from "../../extension/state/Layout.js";
import { toMcpOAuthApprovalConfig } from "../mcp/Runtime.js";
import type { ControlTransportListener } from "../transport/channel/Listener.js";
import { resolveControlWebAssetsDirectory } from "./Assets.js";
import { ControlWebSocketAccessService } from "./auth/Access.js";
import { ControlWebOAuthFlow } from "./auth/OAuth.js";
import { ControlWebSessionService } from "./auth/Session.js";
import { ControlWebSocketListener } from "./Socket.js";
import { ExtensionWebGateway } from "./extension/application/Gateway.js";

export interface ControlWebHostPort {
    readonly host?: Pick<McpHost, "oauthProtectedResource" | "server">;
    readonly oauthApproval: ControlConfig["mcp"]["oauth2"];
    readonly publicBaseUrl?: string;
    readonly webAuth: ControlWebAuthConfig;
    readonly webEnabled: boolean;
    readonly webHost?: HttpHost;
    readonly webOauthDir: string;
    readonly webPublicBaseUrl?: string;
    replaceWebHost(
        previousConfig: ControlConfig,
        config: ControlConfig,
    ): Promise<HttpHost | undefined>;
    restoreWebHost(
        host: HttpHost | undefined,
        config: ControlConfig,
    ): Promise<void>;
    stopRetiredWebHost(host: HttpHost | undefined): Promise<void>;
}

export interface ControlWebTransportPort {
    replaceListener(
        previous: ControlTransportListener,
        next: ControlTransportListener,
    ): Promise<void>;
}

export interface ControlWebRuntimeOptions {
    extensions: ExtensionHost;
    host: ControlWebHostPort;
    paths: ExtensionPathLayout;
}

interface WebRuntimeGeneration {
    flow?: ControlWebOAuthFlow;
    host: HttpHost;
    listener: ControlWebSocketListener;
}

export class ControlWebRuntime {
    readonly #extensions: ExtensionHost;
    readonly #host: ControlWebHostPort;
    readonly #paths: ExtensionPathLayout;
    #flow?: ControlWebOAuthFlow;
    #flowUninstall?: () => void;
    #listener?: ControlWebSocketListener;

    constructor(options: ControlWebRuntimeOptions) {
        this.#extensions = options.extensions;
        this.#host = options.host;
        this.#paths = options.paths;
        const runtime = this.#create();
        this.#flow = runtime?.flow;
        this.#listener = runtime?.listener;
    }

    get listener(): ControlWebSocketListener | undefined {
        return this.#listener;
    }

    async prepare(): Promise<void> {
        await this.#flow?.warmup();
        const webHost = this.#host.webHost;
        if (this.#flow !== undefined && webHost !== undefined) {
            this.#flowUninstall = this.#flow.install(webHost);
        }
    }

    stop(): void {
        this.#flowUninstall?.();
        this.#flow = undefined;
        this.#flowUninstall = undefined;
    }

    async replace(
        previousConfig: ControlConfig,
        nextConfig: ControlConfig,
        transport: ControlWebTransportPort,
    ): Promise<void> {
        const previousHost = await this.#host.replaceWebHost(
            previousConfig,
            nextConfig,
        );
        const previousListener = this.#listener;
        const previousFlow = this.#flow;
        const previousFlowUninstall = this.#flowUninstall;
        let previousFlowRemoved = false;
        let nextRuntime: WebRuntimeGeneration | undefined;
        let nextFlowUninstall: (() => void) | undefined;
        try {
            nextRuntime = this.#create();
            if (previousListener === undefined || nextRuntime === undefined) {
                throw new Error(
                    "Web listener hot replacement requires Web to remain enabled.",
                );
            }
            await nextRuntime.flow?.warmup();
            if (previousFlowUninstall !== undefined) {
                previousFlowUninstall();
                previousFlowRemoved = true;
            }
            nextFlowUninstall = nextRuntime.flow?.install(nextRuntime.host);
            await transport.replaceListener(
                previousListener,
                nextRuntime.listener,
            );
            this.#listener = nextRuntime.listener;
            this.#flow = nextRuntime.flow;
            this.#flowUninstall = nextFlowUninstall;
            await this.#host
                .stopRetiredWebHost(previousHost)
                .catch(reportRetiredWebHostFailure);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
                nextFlowUninstall?.();
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
            }
            await this.#host
                .restoreWebHost(previousHost, previousConfig)
                .catch((rollbackError) => {
                    rollbackFailures.push(rollbackError);
                });
            this.#listener = previousListener;
            this.#flow = previousFlow;
            if (
                previousFlowRemoved &&
                previousFlow !== undefined &&
                this.#host.webHost !== undefined
            ) {
                try {
                    await previousFlow.warmup();
                    this.#flowUninstall = previousFlow.install(
                        this.#host.webHost,
                    );
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
            } else {
                this.#flowUninstall = previousFlowUninstall;
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "Web hot replacement failed and runtime rollback was incomplete.",
                );
            }
            throw error;
        }
    }

    #create(): WebRuntimeGeneration | undefined {
        const http = this.#host.webHost;
        if (http === undefined || !this.#host.webEnabled) return undefined;
        const basePath = controlWebBasePath(this.#host.webPublicBaseUrl);
        const secureCookie =
            this.#host.webPublicBaseUrl?.startsWith("https://") ?? false;
        const sessions = new ControlWebSessionService({
            auth: this.#host.webAuth,
            basePath,
            secureCookie,
        });
        const flow = this.#createOAuthFlow(
            http,
            basePath,
            secureCookie,
            sessions,
        );
        const access = new ControlWebSocketAccessService({
            sessions,
            ...(flow === undefined
                ? {}
                : {
                      onBearerRevoked: (listener) =>
                          flow.onAccessRevoked(listener),
                      verifyBearer: async (token: string) =>
                          await flow.verifyAccessToken(token),
                  }),
        });
        return {
            ...(flow === undefined ? {} : { flow }),
            host: http,
            listener: new ControlWebSocketListener({
                access,
                assetDirectory: resolveControlWebAssetsDirectory(),
                basePath,
                http,
                remotePath: controlRemoteRpcPath(this.#host.webPublicBaseUrl),
                routeInstaller: (host, webSessions) =>
                    new ExtensionWebGateway({
                        basePath: `${basePath}/extensions`,
                        extensions: this.#extensions,
                        loginPath: `${basePath}/`,
                        paths: this.#paths,
                    }).install(host, webSessions),
                sessions,
            }),
        };
    }

    #createOAuthFlow(
        http: HttpHost,
        basePath: string,
        secureCookie: boolean,
        sessions: ControlWebSessionService,
    ): ControlWebOAuthFlow | undefined {
        const auth = this.#host.webAuth;
        const publicBaseUrl = this.#host.webPublicBaseUrl;
        if (auth.mode !== "oauth2" || publicBaseUrl === undefined)
            return undefined;

        const mcpHost = this.#host.host;
        const reused = sameOrigin(publicBaseUrl, this.#host.publicBaseUrl)
            ? mcpHost?.oauthProtectedResource
            : undefined;
        const providerConfig = {
            documentationUrl: auth.oauth2.documentationUrl,
            requiredScopes: [...auth.oauth2.requiredScopes],
            resourceName: auth.oauth2.resourceName,
        };
        const protectedResource =
            reused ??
            new McpOAuthProtectedResource(
                providerConfig,
                new URL(publicBaseUrl).origin,
                this.#host.webOauthDir,
                {
                    approval: toMcpOAuthApprovalConfig(
                        this.#host.oauthApproval,
                    ),
                    trustProxy: isLoopbackPublicBaseUrl(publicBaseUrl),
                },
            );

        return new ControlWebOAuthFlow({
            basePath,
            clientStateFile: join(this.#host.webOauthDir, "client.json"),
            config: providerConfig,
            installProvider: reused === undefined || http !== mcpHost?.server,
            ownsProvider: reused === undefined,
            protectedResource,
            publicBaseUrl,
            secureCookie,
            sessions,
        });
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

function sameOrigin(
    left: string | undefined,
    right: string | undefined,
): boolean {
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

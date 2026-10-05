import { join } from "node:path";

import {
    McpOAuthProtectedResource,
    HttpHost,
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

export interface ControlWebMcpPort {
    readonly host?: Pick<McpHost, "oauthProtectedResource" | "server">;
    readonly oauthApproval: ControlConfig["mcp"]["oauth2"];
    readonly publicBaseUrl?: string;
}

export interface ControlWebTransportPort {
    replaceListener(
        previous: ControlTransportListener,
        next: ControlTransportListener,
    ): Promise<void>;
}

export interface ControlWebRuntimeOptions {
    config: ControlConfig;
    extensions: ExtensionHost;
    mcp: ControlWebMcpPort;
    oauthDirectory: string;
    paths: ExtensionPathLayout;
}

interface WebRuntimeGeneration {
    flow?: ControlWebOAuthFlow;
    host: HttpHost;
    listener: ControlWebSocketListener;
}

export class ControlWebRuntime {
    #auth: ControlWebAuthConfig;
    readonly #extensions: ExtensionHost;
    #enabled: boolean;
    #flow?: ControlWebOAuthFlow;
    #flowUninstall?: () => void;
    #host?: HttpHost;
    #listener?: ControlWebSocketListener;
    readonly #mcp: ControlWebMcpPort;
    readonly #oauthDirectory: string;
    readonly #paths: ExtensionPathLayout;
    #publicBaseUrl?: string;

    constructor(options: ControlWebRuntimeOptions) {
        this.#extensions = options.extensions;
        this.#mcp = options.mcp;
        this.#oauthDirectory = options.oauthDirectory;
        this.#paths = options.paths;
        this.#auth = options.config.web.auth;
        this.#enabled = options.config.web.enabled;
        this.#publicBaseUrl = options.config.web.enabled
            ? options.config.web.publicBaseUrl
            : undefined;
        this.#host = this.#createHost(options.config);
        const runtime = this.#create();
        this.#flow = runtime?.flow;
        this.#listener = runtime?.listener;
    }

    get listener(): ControlWebSocketListener | undefined {
        return this.#listener;
    }

    async prepare(): Promise<void> {
        await this.#flow?.warmup();
        if (this.#flow !== undefined && this.#host !== undefined) {
            this.#flowUninstall = this.#flow.install(this.#host);
        }
    }

    async startHost(): Promise<void> {
        if (this.#host !== undefined && this.#host !== this.#mcp.host?.server) {
            await this.#host.start();
        }
    }

    async stopHost(): Promise<void> {
        if (this.#host !== undefined && this.#host !== this.#mcp.host?.server) {
            await this.#host.stop();
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
        const previousHost = await this.#replaceHost(
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
            await this.#stopRetiredHost(previousHost).catch(
                reportRetiredWebHostFailure,
            );
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            try {
                nextFlowUninstall?.();
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError);
            }
            await this.#restoreHost(previousHost, previousConfig).catch(
                (rollbackError) => {
                    rollbackFailures.push(rollbackError);
                },
            );
            this.#listener = previousListener;
            this.#flow = previousFlow;
            if (
                previousFlowRemoved &&
                previousFlow !== undefined &&
                this.#host !== undefined
            ) {
                try {
                    await previousFlow.warmup();
                    this.#flowUninstall = previousFlow.install(this.#host);
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
        const http = this.#host;
        if (http === undefined || !this.#enabled) return undefined;
        const basePath = controlWebBasePath(this.#publicBaseUrl);
        const secureCookie =
            this.#publicBaseUrl?.startsWith("https://") ?? false;
        const sessions = new ControlWebSessionService({
            auth: this.#auth,
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
                remotePath: controlRemoteRpcPath(this.#publicBaseUrl),
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

    #createHost(config: ControlConfig): HttpHost | undefined {
        if (!config.web.enabled) return undefined;
        return this.#mcp.host !== undefined &&
            sameEndpoint(config.mcp, config.web)
            ? this.#mcp.host.server
            : new HttpHost({
                  listenHost: config.web.listenHost,
                  listenPort: config.web.listenPort,
              });
    }

    #createOAuthFlow(
        http: HttpHost,
        basePath: string,
        secureCookie: boolean,
        sessions: ControlWebSessionService,
    ): ControlWebOAuthFlow | undefined {
        const publicBaseUrl = this.#publicBaseUrl;
        if (this.#auth.mode !== "oauth2" || publicBaseUrl === undefined)
            return undefined;

        const mcpHost = this.#mcp.host;
        const reused = sameOrigin(publicBaseUrl, this.#mcp.publicBaseUrl)
            ? mcpHost?.oauthProtectedResource
            : undefined;
        const providerConfig = {
            documentationUrl: this.#auth.oauth2.documentationUrl,
            requiredScopes: [...this.#auth.oauth2.requiredScopes],
            resourceName: this.#auth.oauth2.resourceName,
        };
        const protectedResource =
            reused ??
            new McpOAuthProtectedResource(
                providerConfig,
                new URL(publicBaseUrl).origin,
                this.#oauthDirectory,
                {
                    approval: toMcpOAuthApprovalConfig(this.#mcp.oauthApproval),
                    trustProxy: isLoopbackPublicBaseUrl(publicBaseUrl),
                },
            );

        return new ControlWebOAuthFlow({
            basePath,
            clientStateFile: `${this.#oauthDirectory}/client.json`,
            config: providerConfig,
            installProvider: reused === undefined || http !== mcpHost?.server,
            ownsProvider: reused === undefined,
            protectedResource,
            publicBaseUrl,
            secureCookie,
            sessions,
        });
    }

    async #replaceHost(
        previousConfig: ControlConfig,
        config: ControlConfig,
    ): Promise<HttpHost | undefined> {
        const previous = this.#host;
        const next = this.#createHost(config);
        const same =
            previous !== undefined &&
            next !== undefined &&
            next !== previous &&
            next !== this.#mcp.host?.server &&
            previous !== this.#mcp.host?.server &&
            sameEndpoint(previousConfig.web, config.web);
        if (same) await previous.stop();
        if (
            next !== undefined &&
            next !== previous &&
            next !== this.#mcp.host?.server
        ) {
            try {
                await next.start();
            } catch (error) {
                const rollbackFailures: unknown[] = [];
                if (same) {
                    await previous
                        .start()
                        .catch((rollbackError) =>
                            rollbackFailures.push(rollbackError),
                        );
                }
                if (rollbackFailures.length > 0) {
                    throw new AggregateError(
                        [error, ...rollbackFailures],
                        "Web host replacement failed and rollback was incomplete.",
                    );
                }
                throw error;
            }
        }
        this.#auth = config.web.auth;
        this.#enabled = config.web.enabled;
        this.#publicBaseUrl = config.web.enabled
            ? config.web.publicBaseUrl
            : undefined;
        this.#host = next;
        return previous;
    }

    async #restoreHost(
        host: HttpHost | undefined,
        config: ControlConfig,
    ): Promise<void> {
        const current = this.#host;
        this.#auth = config.web.auth;
        this.#enabled = config.web.enabled;
        this.#publicBaseUrl = config.web.enabled
            ? config.web.publicBaseUrl
            : undefined;
        this.#host = host;
        if (
            current !== undefined &&
            current !== host &&
            current !== this.#mcp.host?.server
        ) {
            await current.stop();
        }
        if (host !== undefined && host !== this.#mcp.host?.server) {
            await host.start();
        }
    }

    async #stopRetiredHost(host: HttpHost | undefined): Promise<void> {
        if (
            host !== undefined &&
            host !== this.#host &&
            host !== this.#mcp.host?.server
        ) {
            await host.stop();
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

function sameEndpoint(
    left: { listenHost: string; listenPort: number },
    right: { listenHost: string; listenPort: number },
): boolean {
    return (
        left.listenHost === right.listenHost &&
        left.listenPort === right.listenPort
    );
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

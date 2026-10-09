import type {
    ControlConfig,
    Endpoint,
    ServerTransport,
} from "@portable-devshell/shared";

import type { ArtifactRuntime } from "../artifact/Api.js";
import type { ConfigChangeHub } from "../config/change/Config.js";
import type { ConfigRuntimeChangeSet } from "../config/engine/Api.js";
import type { ConfigEditorCoordinator } from "../config/editor/index.js";
import type { ContextRuntime } from "../context/Api.js";
import type { DebugRuntime } from "../debug/Api.js";
import type { ExtensionRuntime } from "../extension/Api.js";
import { CliExtensionCommandService } from "../extension/api/point/cli/command/index.js";
import { ControlExtensionRouteService } from "../extension/api/point/control/Dispatch.js";
import { TuiExtensionPageService } from "../extension/api/point/tui/index.js";
import type { InstanceRegistry } from "../instance/Api.js";
import type { InstanceChangeHub } from "../instance/Change.js";
import type { InstanceCreateCoordinator } from "../instance/editor/create/index.js";
import type { InstanceEditorCoordinator } from "../instance/editor/index.js";
import type { ReverseCredentials } from "../instance/reverse/Credentials.js";
import { createOperationalOverviewRuntime } from "../overview/index.js";
import { OperationalOverviewInstanceCollector } from "../overview/collector/Instance.js";
import { ControlRouteRegistry } from "./Route.js";
import { ControlHttpServer } from "./http/index.js";
import type { ControlHttpLease } from "./http/Api.js";
import type { McpControlModule } from "./mcp/Module.js";
import type { ReverseIngress } from "./reverse/Ingress.js";
import type { ControlTransportListener } from "./transport/channel/Listener.js";
import { ControlSocketListener } from "./transport/channel/Socket.js";
import { ControlTransportServer } from "./transport/endpoint/Server.js";
import { ControlWebRuntime } from "./web/Runtime.js";
import { WebApplicationCatalog } from "./web/extension/application/Catalog.js";
import { WebExtensionPageService } from "./web/extension/page/Service.js";
import { createContextRouteModule } from "../context/Public.js";
import { ControlServerConfig } from "./Config.js";

export interface ControlServerOptions {
    artifact: ArtifactRuntime;
    config: () => ControlConfig;
    configChanges: ConfigChangeHub;
    configEditor: ConfigEditorCoordinator;
    contexts: ContextRuntime;
    debug: DebugRuntime;
    extensions: ExtensionRuntime;
    instanceCreate: InstanceCreateCoordinator;
    instanceEditor: InstanceEditorCoordinator;
    instanceChanges: InstanceChangeHub;
    instances: InstanceRegistry;
    onConnectionDetached(connectionId: string): void;
    http: ControlHttpServer;
    internalControl: {
        endpoint: Endpoint;
        server: ServerTransport;
    };
    mcp: McpControlModule;
    restart: () => Promise<void>;
    reverse: {
        credentials?: ReverseCredentials;
        ingress?: ReverseIngress;
    };
    shutdown: () => Promise<void>;
    socketPath: string;
    web: ControlWebRuntime;
}

export class ControlServer {
    readonly #artifact: ArtifactRuntime;
    readonly #config: ControlServerConfig;
    readonly #readConfig: () => ControlConfig;
    readonly #extensionRoutes: ControlExtensionRouteService;
    readonly #internalControlEndpoint: Endpoint;
    readonly #internalControlServer: ServerTransport;
    readonly #mcp: McpControlModule;
    readonly #http: ControlHttpServer;
    #artifactHttp?: ControlHttpLease;
    #artifactUninstall?: () => void;
    #reverseHttp?: ControlHttpLease;
    #httpRoutesConfig?: Pick<ControlConfig["mcp"], "enabled" | "listenHost" | "listenPort" | "publicBaseUrl">;
    readonly #reverseCredentials?: ReverseCredentials;
    readonly #reverseIngress?: ReverseIngress;
    readonly #routes: ControlRouteRegistry;
    readonly #socketListener: ControlSocketListener;
    readonly #transport: ControlTransportServer;
    readonly #web: ControlWebRuntime;
    #ready = false;

    constructor(options: ControlServerOptions) {
        this.#artifact = options.artifact;
        this.#readConfig = options.config;
        this.#internalControlEndpoint = options.internalControl.endpoint;
        this.#internalControlServer = options.internalControl.server;
        this.#mcp = options.mcp;
        this.#http = options.http;
        this.#reverseCredentials = options.reverse.credentials;
        this.#reverseIngress = options.reverse.ingress;

        this.#extensionRoutes = new ControlExtensionRouteService(options.extensions);
        this.#routes = new ControlRouteRegistry({
            artifact: options.artifact.service,
            cliCommands: new CliExtensionCommandService(options.extensions, {
                surface: "native",
            }),
            config: options.configEditor,
            configChanges: options.configChanges,
            ...(options.config === undefined
                ? {}
                : { configuredInstances: () => options.config!().instances }),
            controlPorts: [createContextRouteModule(options.contexts.api)],
            controlReady: () => this.#ready,
            debug: options.debug,
            extension: options.extensions.control,
            extensionRoutes: this.#extensionRoutes,
            instanceCreate: options.instanceCreate,
            instanceEditor: options.instanceEditor,
            instanceChanges: options.instanceChanges,
            instances: options.instances,
            mcpStatus: () => options.mcp.status(),
            oauthApprovals: () => options.mcp.oauthApprovals,
            overview: createOperationalOverviewRuntime({
                instanceCollector: new OperationalOverviewInstanceCollector({
                    activityLimit: 20,
                    endpoint: options.internalControl.endpoint,
                }),
                instances: options.instances,
                oauthApprovals: () => options.mcp.oauthApprovals,
            }),
            restart: options.restart,
            reverse: this.#reverseCredentials,
            shutdown: options.shutdown,
            tuiPages: new TuiExtensionPageService(options.extensions),
            webApplications: new WebApplicationCatalog(options.extensions),
            webPages: new WebExtensionPageService(options.extensions),
        });
        this.#socketListener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#web = options.web;
        const listeners: ControlTransportListener[] = [this.#socketListener];
        if (this.#web.listener !== undefined) listeners.push(this.#web.listener);
        this.#transport = new ControlTransportServer({
            listeners,
            onConnectionDetached: options.onConnectionDetached,
            routes: this.#routes,
        });
        this.#config = new ControlServerConfig({
            mcp: this.#mcp,
            replaceHttpRoutes: (config) => this.#replaceHttpRoutes(config),
            transport: this.#transport,
            web: this.#web,
        });
    }

    async applyRuntimeConfig(
        previous: ControlConfig,
        next: ControlConfig,
        changes: ConfigRuntimeChangeSet,
    ): Promise<boolean> {
        return await this.#config.apply(previous, next, changes);
    }

    async retireInstanceGeneration(instance: string): Promise<void> {
        await this.#extensionRoutes.retireInstance(instance);
    }

    async prepare(): Promise<void> {
        await this.#web.prepare();
    }

    async startTransport(): Promise<void> {
        await this.#transport.start();
        await this.#internalControlServer.hello();
    }

    async startHosts(): Promise<void> {
        await this.#mcp.start();
        await this.#replaceHttpRoutes(this.#readConfig());
        await this.#web.startHost();
    }

    /** Control owns the Artifact and Reverse routes, independently of MCP generations. */
    async #replaceHttpRoutes(config: ControlConfig): Promise<void> {
        const endpoint = config.mcp;
        const current = this.#httpRoutesConfig;
        if (current !== undefined &&
            current.enabled === endpoint.enabled &&
            current.listenHost === endpoint.listenHost &&
            current.listenPort === endpoint.listenPort &&
            current.publicBaseUrl === endpoint.publicBaseUrl) return;

        const oldArtifact = this.#artifactHttp;
        const oldUninstall = this.#artifactUninstall;
        const oldReverse = this.#reverseHttp;
        let nextArtifact: ControlHttpLease | undefined;
        let nextReverse: ControlHttpLease | undefined;
        let nextUninstall: (() => void) | undefined;
        try {
            if (endpoint.enabled) {
                const address = { listenHost: endpoint.listenHost, listenPort: endpoint.listenPort };
                nextArtifact = this.#http.acquire(address);
                nextUninstall = this.#artifact.installHttpRoute(nextArtifact, endpoint.publicBaseUrl);
                await nextArtifact.start();
                if (this.#reverseIngress !== undefined) {
                    nextReverse = this.#http.acquire(address);
                    await nextReverse.start();
                }
            }
            if (this.#reverseIngress !== undefined) {
                if (nextReverse !== undefined) {
                    if (endpoint.publicBaseUrl !== undefined) {
                        this.#reverseCredentials?.setPublicBaseUrl(endpoint.publicBaseUrl);
                        this.#reverseIngress.setPublicBaseUrl(endpoint.publicBaseUrl);
                    }
                    this.#reverseIngress.install(nextReverse);
                } else {
                    this.#reverseIngress.uninstall();
                }
            }
        } catch (error) {
            const failures: unknown[] = [];
            try {
                if (current?.publicBaseUrl !== undefined) {
                    this.#reverseCredentials?.setPublicBaseUrl(current.publicBaseUrl);
                    this.#reverseIngress?.setPublicBaseUrl(current.publicBaseUrl);
                }
                if (oldReverse !== undefined) this.#reverseIngress?.install(oldReverse);
                else this.#reverseIngress?.uninstall();
            } catch (rollbackError) { failures.push(rollbackError); }
            try { nextUninstall?.(); }
            catch (cleanupError) { failures.push(cleanupError); }
            const cleanup = await Promise.allSettled([
                nextArtifact?.dispose(), nextReverse?.dispose(),
            ]);
            for (const result of cleanup)
                if (result.status === "rejected") failures.push(result.reason);
            if (failures.length > 0)
                throw new AggregateError([error, ...failures], "Control HTTP route replacement rollback failed.");
            throw error;
        }

        this.#artifactHttp = nextArtifact;
        this.#artifactUninstall = nextUninstall;
        this.#reverseHttp = nextReverse;
        this.#httpRoutesConfig = {
            enabled: endpoint.enabled,
            listenHost: endpoint.listenHost,
            listenPort: endpoint.listenPort,
            ...(endpoint.publicBaseUrl === undefined ? {} : { publicBaseUrl: endpoint.publicBaseUrl }),
        };
        oldUninstall?.();
        const retired = await Promise.allSettled([oldArtifact?.dispose(), oldReverse?.dispose()]);
        const failures = retired.filter((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failures.length > 0)
            throw new AggregateError(failures.map((result) => result.reason), "Retired Control HTTP leases failed to close.");
    }

    /**
     * Marks Control fully ready. Called by `Control` after the domain
     * `state.reconcile` that follows `startHosts`, so `core.status` does not
     * advertise readiness while MCP/Web listeners are still coming up.
     */
    markReady(): void {
        this.#ready = true;
    }

    async stop(): Promise<void> {
        const failures: unknown[] = [];
        try { this.#artifactUninstall?.(); }
        catch (error) { failures.push(error); }
        this.#artifactUninstall = undefined;
        try { this.#reverseIngress?.uninstall(); }
        catch (error) { failures.push(error); }
        await this.#artifactHttp?.dispose().catch((error) => failures.push(error));
        await this.#reverseHttp?.dispose().catch((error) => failures.push(error));
        this.#artifactHttp = undefined;
        this.#reverseHttp = undefined;
        try {
            this.#internalControlEndpoint.close();
        } catch (error) {
            failures.push(error);
        }
        await this.#transport.close().catch((error) => failures.push(error));
        await this.#web.stopHost().catch((error) => failures.push(error));
        await this.#mcp.stop().catch((error) => failures.push(error));
        await this.#http.close().catch((error) => failures.push(error));
        this.#web.stop();
        try {
            this.#reverseIngress?.stop();
        } catch (error) {
            failures.push(error);
        }
        try {
            this.#routes.dispose();
        } catch (error) {
            failures.push(error);
        }
        await this.#socketListener
            .removeEndpoint()
            .catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Control server runtime failed to stop cleanly.",
            );
        }
    }
}

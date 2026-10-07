import type {
    ControlConfig,
    Endpoint,
    ServerTransport,
    ToolCallApi,
} from "@portable-devshell/shared";

import type { ArtifactRuntime } from "../artifact/Api.js";
import type { ConfigChangeHub } from "../config/change/Config.js";
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
import type { McpControlModule } from "./mcp/Module.js";
import type { ReverseIngress } from "./reverse/Ingress.js";
import type { ControlTransportListener } from "./transport/channel/Listener.js";
import { ControlSocketListener } from "./transport/channel/Socket.js";
import { ControlTransportServer } from "./transport/endpoint/Server.js";
import { ControlWebRuntime } from "./web/Runtime.js";
import { WebApplicationCatalog } from "./web/extension/application/Catalog.js";
import { WebExtensionPageService } from "./web/extension/page/Service.js";
import { createContextRouteModule } from "../context/Public.js";

export interface ControlServerOptions {
    artifact: ArtifactRuntime;
    config?: () => ControlConfig;
    configChanges: ConfigChangeHub;
    configEditor: ConfigEditorCoordinator;
    contexts: ContextRuntime;
    debug: DebugRuntime;
    extensions: ExtensionRuntime;
    instanceCreate: InstanceCreateCoordinator;
    instanceEditor: InstanceEditorCoordinator;
    instanceChanges: InstanceChangeHub;
    instances: InstanceRegistry;
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
    toolCalls: ToolCallApi;
    web: ControlWebRuntime;
}

export class ControlServer {
    readonly #internalControlEndpoint: Endpoint;
    readonly #internalControlServer: ServerTransport;
    readonly #mcp: McpControlModule;
    readonly #reverseCredentials?: ReverseCredentials;
    readonly #reverseIngress?: ReverseIngress;
    readonly #routes: ControlRouteRegistry;
    readonly #socketListener: ControlSocketListener;
    readonly #transport: ControlTransportServer;
    readonly #web: ControlWebRuntime;

    constructor(options: ControlServerOptions) {
        this.#internalControlEndpoint = options.internalControl.endpoint;
        this.#internalControlServer = options.internalControl.server;
        this.#mcp = options.mcp;
        this.#mcp.setToolCalls(options.toolCalls);
        this.#reverseCredentials = options.reverse.credentials;
        this.#reverseIngress = options.reverse.ingress;

        const extensionRoutes = new ControlExtensionRouteService(options.extensions);
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
            debug: options.debug,
            extension: options.extensions.control,
            extensionRoutes,
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
        options.instanceEditor.registerInstanceGenerationRetirement(
            async (instance) => {
                await extensionRoutes.retireInstance(instance.name);
            },
        );

        this.#socketListener = new ControlSocketListener({
            socketPath: options.socketPath,
        });
        this.#web = options.web;
        const listeners: ControlTransportListener[] = [this.#socketListener];
        if (this.#web.listener !== undefined) listeners.push(this.#web.listener);
        this.#transport = new ControlTransportServer({
            listeners,
            routes: this.#routes,
        });

        this.#mcp.setWebConfigApplier?.(
            async (previous, next) =>
                await this.#web.replace(previous, next, this.#transport),
        );
        this.#mcp.setMcpConfigApplier?.(async (previous, next) => {
            const retired = await this.#mcp.replaceMcpHost(previous, next);
            try {
                const host = this.#mcp.host;
                if (host !== undefined && this.#reverseIngress !== undefined) {
                    if (next.mcp.publicBaseUrl !== undefined) {
                        this.#reverseCredentials?.setPublicBaseUrl(
                            next.mcp.publicBaseUrl,
                        );
                        this.#reverseIngress.setPublicBaseUrl(
                            next.mcp.publicBaseUrl,
                        );
                    }
                    this.#reverseIngress.install(host.server);
                }
                await retired?.stop();
            } catch (error) {
                const rollbackFailures: unknown[] = [];
                await this.#mcp
                    .restoreMcpHost(retired, previous)
                    .catch((rollbackError) => {
                        rollbackFailures.push(rollbackError);
                    });
                try {
                    const host = this.#mcp.host;
                    if (host !== undefined && this.#reverseIngress !== undefined) {
                        if (previous.mcp.publicBaseUrl !== undefined) {
                            this.#reverseCredentials?.setPublicBaseUrl(
                                previous.mcp.publicBaseUrl,
                            );
                            this.#reverseIngress.setPublicBaseUrl(
                                previous.mcp.publicBaseUrl,
                            );
                        }
                        this.#reverseIngress.install(host.server);
                    }
                } catch (rollbackError) {
                    rollbackFailures.push(rollbackError);
                }
                if (rollbackFailures.length > 0) {
                    throw new AggregateError(
                        [error, ...rollbackFailures],
                        "MCP hot replacement failed and runtime rollback was incomplete.",
                    );
                }
                throw error;
            }
        });
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
        if (this.#reverseIngress !== undefined && this.#mcp.host !== undefined) {
            this.#reverseIngress.install(this.#mcp.host.server);
        }
        await this.#web.startHost();
    }

    async stop(): Promise<void> {
        const failures: unknown[] = [];
        try {
            this.#internalControlEndpoint.close();
        } catch (error) {
            failures.push(error);
        }
        await this.#transport.close().catch((error) => failures.push(error));
        await this.#web.stopHost().catch((error) => failures.push(error));
        await this.#mcp.stop().catch((error) => failures.push(error));
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

import {
    McpServer,
    McpHost,
    type McpHttpAccess,
    type McpOAuthApprovalService,
    type McpOAuth2Config,
    type McpOAuthApprovalConfig,
    type McpOAuthProtectedResource,
} from "@portable-devshell/mcp";
import type {
    ContextTransport,
    ContextRecord,
    ControlConfig,
    Endpoint,
    JsonValue,
} from "@portable-devshell/shared";

import type { InstanceMcpRuntimePort } from "../../instance/Mcp.js";
import type { ContextChangeSource } from "../../context/Api.js";
import {
    type ToolCallProvenanceApi,
} from "@portable-devshell/shared";
import type { InstanceRegistry } from "../../instance/Api.js";
import { McpEndpointFactory } from "./Endpoint.js";
import { McpRuntimeFactory } from "./Runtime.js";
import type { ControlPathHome } from "@portable-devshell/shared";
import type { ToolCallRegistry } from "../../toolcall/Api.js";

export interface McpControlModuleOptions {
    config: ControlConfig;
    context: Pick<ContextTransport, "resolve" | "validateForInstance">;
    contextChanges?: ContextChangeSource;
    contextRecords?: () => Promise<ContextRecord[]>;
    endpoint?: Endpoint;
    controlPaths: ControlPathHome;
    factory?: McpRuntimeFactory;
    http: McpHttpAccess;
    instances: InstanceRegistry;
    toolRegistry: ToolCallRegistry;
}

export class McpControlModule {
    readonly instancePort: InstanceMcpRuntimePort;
    readonly toolProvenance: ToolCallProvenanceApi;
    #publicBaseUrl?: string;
    #oauthApproval: ControlConfig["mcp"]["oauth2"];
    #host?: McpHost;
    readonly #factory: McpRuntimeFactory;
    readonly #instances: InstanceRegistry;
    readonly #http: McpHttpAccess;
    readonly #controlPaths: ControlPathHome;
    readonly #runtimeState: McpServer;
    readonly #toolRegistry: ToolCallRegistry;
    readonly #contextRecords?: () => Promise<ContextRecord[]>;
    readonly #contextChanges?: ContextChangeSource;
    #unsubscribeContexts?: () => void;
    #contextCleanup: Promise<void> = Promise.resolve();
    readonly #contextCleanupFailures: unknown[] = [];

    constructor(options: McpControlModuleOptions) {
        const factory = options.factory ?? new McpRuntimeFactory();
        this.#factory = factory;
        this.#instances = options.instances;
        this.#http = options.http;
        this.#controlPaths = options.controlPaths;
        this.#toolRegistry = options.toolRegistry;
        this.#runtimeState = new McpServer({
            context: options.context,
            ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
            tools: { call: (instance, ...args) => {
                const target = options.instances.get(instance);
                if (target === undefined)
                    throw new Error(`Instance ${instance} is unavailable.`);
                return target.toolCallIngress.call(instance, ...args);
            } },
            storageDir: options.controlPaths.oauthDir,
            mcpAppLeaseFile: options.controlPaths.mcpAppLeasesFile,
            toolProvenanceFile: options.controlPaths.toolProvenanceFile,
        });
        this.#contextRecords = options.contextRecords;
        this.#contextChanges = options.contextChanges;
        this.#subscribeContexts();
        if (this.#runtimeState.protocol === undefined)
            throw new Error('MCP protocol provenance runtime is unavailable.');
        this.toolProvenance = this.#runtimeState.protocol.provenance;
        const config = options.config;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.publicBaseUrl;
        const endpointFactory = new McpEndpointFactory();
        this.instancePort = {
            registerInstance: (instance, auth) => {
                const descriptor = options.instances.get(instance);
                if (descriptor === undefined) return;
                this.#host?.registerInstance(
                    endpointFactory.map(descriptor, auth),
                );
            },
            unregisterInstance: (instance) => {
                this.#host?.unregisterInstance(instance);
            },
            retireMcpApp: async (instance) => {
                if (this.#host !== undefined) await this.#host.retireMcpApp(instance);
                else await this.#runtimeState.app.revokeInstance(instance);
            },
        };
        this.#host = factory.wire(config, options.instances, {
            storageDir: options.controlPaths.oauthDir,
            runtimeState: this.#runtimeState,
            http: this.#http,
            toolProvenance: this.toolProvenance,
            toolSource: this.#toolRegistry,
            mcpAppLeaseFile: options.controlPaths.mcpAppLeasesFile,
        });
    }

    get host(): McpHost | undefined {
        return this.#host;
    }

    get oauthApproval(): ControlConfig["mcp"]["oauth2"] {
        return this.#oauthApproval;
    }

    get publicBaseUrl(): string | undefined {
        return this.#publicBaseUrl;
    }

    async replaceMcpHost(
        previousConfig: ControlConfig,
        config: ControlConfig,
    ): Promise<McpHost | undefined> {
        const next = this.#factory.wire(config, this.#instances, {
            storageDir: this.#controlPaths.oauthDir,
            runtimeState: this.#runtimeState,
            http: this.#http,
            toolProvenance: this.toolProvenance,
            toolSource: this.#toolRegistry,
            mcpAppLeaseFile: this.#controlPaths.mcpAppLeasesFile,
        });
        const previous = this.#host;
        const sameEndpointAsPrevious =
            previous !== undefined &&
            sameEndpoint(previousConfig.mcp, config.mcp);
        if (sameEndpointAsPrevious) await this.stopHost(previous);
        try {
            if (next !== undefined) await this.#startHost(next);
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            if (next instanceof McpHost) {
                await next.dispose().catch((cleanupError) => rollbackFailures.push(cleanupError));
            }
            if (sameEndpointAsPrevious) {
                await this.#startHost(previous)
                    .catch((rollbackError) =>
                        rollbackFailures.push(rollbackError),
                    );
            }
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "MCP host replacement failed and rollback was incomplete.",
                );
            }
            throw error;
        }
        this.#host = next;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.enabled
            ? config.mcp.publicBaseUrl
            : undefined;
        return previous;
    }

    async restoreMcpHost(
        host: McpHost | undefined,
        config: ControlConfig,
    ): Promise<void> {
        const current = this.#host;
        this.#host = host;
        this.#oauthApproval = config.mcp.oauth2;
        this.#publicBaseUrl = config.mcp.enabled
            ? config.mcp.publicBaseUrl
            : undefined;
        const failures: unknown[] = [];
        if (current !== undefined && current !== host) {
            await this.stopHost(current).catch((error) => failures.push(error));
            if (current instanceof McpHost)
                await current.dispose().catch((error) => failures.push(error));
        }
        if (host !== undefined)
            await this.#startHost(host).catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "MCP host rollback was incomplete.",
            );
        }
    }

    oauthResource(config: McpOAuth2Config, publicBaseUrl: string, storageDir: string,
        approval: McpOAuthApprovalConfig, trustProxy: boolean): McpOAuthProtectedResource {
        return this.#runtimeState.oauth.resource(config, publicBaseUrl, storageDir, approval, trustProxy);
    }

    get oauthApprovals(): McpOAuthApprovalService | undefined {
        return this.#host?.oauthApprovals;
    }

    status(): JsonValue {
        if (this.#host === undefined) {
            return {
                running: false,
                reason: "MCP runtime is disabled.",
            };
        }
        return (
            (
                this.#host as unknown as { status(): JsonValue } | undefined
            )?.status() ?? {
                running: false,
                reason: "MCP runtime is disabled.",
            }
        );
    }

    #subscribeContexts(): void {
        if (this.#unsubscribeContexts !== undefined) return;
        this.#unsubscribeContexts = this.#contextChanges?.onChange((change) => {
            for (const ctxId of change.terminalCtxIds ?? []) {
                this.#contextCleanup = this.#contextCleanup.then(async () => {
                    this.#host?.revokeMcpAppContext(ctxId);
                    await this.#runtimeState.app.revokeContext(ctxId);
                }).catch((error: unknown) => { this.#contextCleanupFailures.push(error); });
            }
        });
    }

    async start(): Promise<void> {
        this.#subscribeContexts();
        await this.#runtimeState.app.initialize();
        await this.#contextCleanup;
        if (this.#contextCleanupFailures.length > 0)
            throw new AggregateError(this.#contextCleanupFailures, 'MCP App Context cleanup failed.');
        if (this.#contextRecords !== undefined)
            await this.#runtimeState.app.reconcileContexts(await this.#contextRecords());
        if (this.#host !== undefined) await this.#startHost(this.#host);
    }

    // Physical HTTP listening is controlled by ControlServer through this module.
    async #startHost(host: Pick<McpHost, "start" | "stop">): Promise<void> {
        if (!(host instanceof McpHost)) { await host.start(); return; }
        try {
            await host.prepare();
            await host.server.start();
        }
        catch (error) { host.retire(); throw error; }
    }

    async stopHost(host: Pick<McpHost, "start" | "stop">): Promise<void> {
        if (!(host instanceof McpHost)) { await host.stop(); return; }
        host.retire();
        await host.server.stop();
    }

    async stop(): Promise<void> {
        this.#unsubscribeContexts?.();
        this.#unsubscribeContexts = undefined;
        await this.#contextCleanup;
        const failures: unknown[] = this.#contextCleanupFailures.splice(0);
        if (this.#host !== undefined) {
            await this.stopHost(this.#host).catch((error) => failures.push(error));
            if (this.#host instanceof McpHost)
                await this.#host.dispose().catch((error) => failures.push(error));
        }
        await this.#runtimeState.close().catch((error) => failures.push(error));
        if (failures.length > 0) {
            throw new AggregateError(failures, "MCP module shutdown failed.");
        }
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

import { createServer, type Server, type Socket } from "node:net";

import { createError, errorCodes, toControlErrorBody, type ControlErrorBody, type JsonValue } from "@portable-devshell/shared";
import type { McpOAuthApprovalService } from "@portable-devshell/mcp";
import type { ArtifactService } from "../../artifact/ArtifactService.js";

import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import type { ControlConfigEditorService } from "../editor/ConfigEditorService.js";
import type { ControlInstanceCreateService } from "../ControlInstanceCreateService.js";
import type { ReverseControlService } from "../../reverse/ReverseControlService.js";
import { RouteMethodRegistry } from "../../route/RouteMethodRegistry.js";
import { RouteHandlerControl } from "../../route/handler/RouteHandlerControl.js";
import { RouteHandlerInstance } from "../../route/handler/RouteHandlerInstance.js";
import { RouteRouterControl } from "../../route/router/RouteRouterControl.js";
import { RouteRouterInstance } from "../../route/router/RouteRouterInstance.js";
import { StreamSubscriptionManager } from "../../stream/StreamSubscriptionManager.js";
import { removeControlIpcEndpoint } from "../platform/ControlIpcEndpoint.js";
import { ControlRpcConnection, type RpcRequestEnvelope } from "./ControlRpcConnection.js";

export interface ControlRpcServerOptions {
    artifactService?: ArtifactService;
    configEditorService?: ControlConfigEditorService;
    instanceCreateService?: ControlInstanceCreateService;
    instanceRegistry: InstanceRegistry;
    getOAuthApprovals?: () => McpOAuthApprovalService | undefined;
    getMcpStatus?: () => JsonValue;
    shutdown?: () => Promise<void> | void;
    restart?: () => Promise<void> | void;
    reverseControlService?: ReverseControlService;
    socketPath: string;
}

export class ControlRpcServer {
    readonly #instanceRegistry: InstanceRegistry;
    readonly #shutdown?: () => Promise<void> | void;
    readonly #restart?: () => Promise<void> | void;
    readonly #socketPath: string;
    readonly #methodRegistry = new RouteMethodRegistry();
    readonly #subscriptionManager = new StreamSubscriptionManager();
    readonly #controlRouter: RouteRouterControl;
    readonly #instanceRouter: RouteRouterInstance;
    readonly #connections = new Map<string, ControlRpcConnection>();
    #server?: Server;
    #stopPromise?: Promise<void>;

    constructor(options: ControlRpcServerOptions) {
        this.#instanceRegistry = options.instanceRegistry;
        this.#shutdown = options.shutdown;
        this.#restart = options.restart;
        this.#socketPath = options.socketPath;
        this.#controlRouter = new RouteRouterControl(
            new RouteHandlerControl({
                artifactService: options.artifactService,
                configEditorService: options.configEditorService,
                getOAuthApprovals: options.getOAuthApprovals,
                getMcpStatus: options.getMcpStatus,
                instanceRegistry: this.#instanceRegistry,
                instanceCreateService: options.instanceCreateService,
                reverseControlService: options.reverseControlService
            })
        );
        this.#instanceRouter = new RouteRouterInstance(
            new RouteHandlerInstance({
                instanceRegistry: this.#instanceRegistry,
                streamSubscriptionManager: this.#subscriptionManager
            })
        );
    }

    async start(): Promise<void> {
        await removeControlIpcEndpoint(this.#socketPath);

        this.#server = createServer((socket) => {
            this.#attachConnection(socket);
        });

        await new Promise<void>((resolve, reject) => {
            this.#server?.once("error", reject);
            this.#server?.listen(this.#socketPath, () => {
                this.#server?.off("error", reject);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.#stopPromise !== undefined) {
            return await this.#stopPromise;
        }

        this.#stopPromise = this.#stopInternal();

        try {
            await this.#stopPromise;
        } finally {
            this.#stopPromise = undefined;
        }
    }

    async #stopInternal(): Promise<void> {
        for (const connection of this.#connections.values()) {
            connection.close();
        }

        this.#connections.clear();

        if (this.#server === undefined) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.#server?.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });

        this.#server = undefined;
        await removeControlIpcEndpoint(this.#socketPath);
    }

    #attachConnection(socket: Socket): void {
        const connection = new ControlRpcConnection(socket);
        this.#connections.set(connection.id, connection);
        connection.start(
            async (request) => {
                await this.#handleRequest(connection, request);
            },
            () => {
                this.#connections.delete(connection.id);
                this.#subscriptionManager.unsubscribeConnection(connection.id);
            }
        );
    }

    async #handleRequest(connection: ControlRpcConnection, request: RpcRequestEnvelope): Promise<void> {
        const scope = this.#methodRegistry.resolve(request.method);

        if (scope === undefined) {
            await connection.sendResponse({
                error: this.#errorBody(errorCodes.envelopeInvalid, `Method ${request.method} was not found.`, false),
                id: request.id,
                ok: false,
                type: "response"
            });
            return;
        }

        try {
            const result =
                scope === "control"
                    ? await this.#controlRouter.route(connection, request)
                    : await this.#instanceRouter.route(connection, request);

            await connection.sendResponse({
                id: request.id,
                ok: true,
                result,
                type: "response"
            });

            if (request.method === "control.shutdown") {
                queueMicrotask(() => {
                    void (this.#shutdown?.() ?? this.stop());
                });
            } else if (request.method === "control.restart") {
                queueMicrotask(() => {
                    void this.#restart?.();
                });
            }
        } catch (error) {
            const body = this.#toErrorBody(error);
            await connection.sendResponse({
                error: body,
                id: request.id,
                ok: false,
                type: "response"
            });
        }
    }

    #toErrorBody(error: unknown): ControlErrorBody {
        const errorBody = toControlErrorBody(error);

        if (errorBody !== undefined) {
            return errorBody;
        }

        return createError({
            code: errorCodes.envelopeInvalid,
            cause: error,
            message: error instanceof Error ? error.message : String(error),
            retryable: false
        }).toBody();
    }

    #errorBody(code: string, message: string, retryable: boolean): ControlErrorBody {
        return createError({
            code,
            message,
            retryable
        }).toBody();
    }
}

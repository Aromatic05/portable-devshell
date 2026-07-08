import { unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";

import type { ControlErrorBody } from "@portable-devshell/shared";

import type { InstanceRegistry } from "../../instance/registry/InstanceRegistry.js";
import { RouteMethodRegistry } from "../../route/RouteMethodRegistry.js";
import { RouteHandlerControl } from "../../route/handler/RouteHandlerControl.js";
import { RouteHandlerInstance } from "../../route/handler/RouteHandlerInstance.js";
import { RouteRouterControl } from "../../route/router/RouteRouterControl.js";
import { RouteRouterInstance } from "../../route/router/RouteRouterInstance.js";
import { StreamSubscriptionManager } from "../../stream/StreamSubscriptionManager.js";
import { ControlRpcConnection, type RpcRequestEnvelope } from "./ControlRpcConnection.js";

export interface ControlRpcServerOptions {
    instanceRegistry: InstanceRegistry;
    shutdown?: () => Promise<void> | void;
    socketPath: string;
}

export class ControlRpcServer {
    readonly #instanceRegistry: InstanceRegistry;
    readonly #shutdown?: () => Promise<void> | void;
    readonly #socketPath: string;
    readonly #methodRegistry = new RouteMethodRegistry();
    readonly #subscriptionManager = new StreamSubscriptionManager();
    readonly #controlRouter: RouteRouterControl;
    readonly #instanceRouter: RouteRouterInstance;
    readonly #connections = new Map<string, ControlRpcConnection>();
    #server?: Server;

    constructor(options: ControlRpcServerOptions) {
        this.#instanceRegistry = options.instanceRegistry;
        this.#shutdown = options.shutdown;
        this.#socketPath = options.socketPath;
        this.#controlRouter = new RouteRouterControl(
            new RouteHandlerControl({
                instanceRegistry: this.#instanceRegistry,
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
        await unlink(this.#socketPath).catch(() => undefined);

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
        await unlink(this.#socketPath).catch(() => undefined);
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
                error: this.#errorBody("protocol.envelope_invalid", `Method ${request.method} was not found.`, false),
                id: request.id,
                ok: false,
                type: "response"
            });
            return;
        }

        try {
            const result =
                scope === "control"
                    ? await this.#controlRouter.route(request)
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
        if (
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string" &&
            "message" in error &&
            typeof error.message === "string" &&
            "retryable" in error &&
            typeof error.retryable === "boolean"
        ) {
            return error as ControlErrorBody;
        }

        return this.#errorBody("protocol.envelope_invalid", error instanceof Error ? error.message : String(error), false);
    }

    #errorBody(code: string, message: string, retryable: boolean): ControlErrorBody {
        return {
            code: code as ControlErrorBody["code"],
            message,
            retryable
        };
    }
}

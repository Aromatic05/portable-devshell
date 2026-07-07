import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { McpAuthMiddleware, type McpAuthConfig } from "../auth/McpAuthMiddleware.js";
import type { McpEndpointRequestHandler } from "../endpoint/McpEndpointRequestHandler.js";
import type { McpHostRouteMatcher } from "./route/McpHostRouteMatcher.js";
import type { McpHostRouteRegistry } from "./route/McpHostRouteRegistry.js";

type JsonValue = boolean | number | null | string | JsonValue[] | { [key: string]: JsonValue };

interface McpHostHttpServerOptions {
    auth?: McpAuthConfig;
    handler: McpEndpointRequestHandler;
    listenHost: string;
    listenPort: number;
    matcher: McpHostRouteMatcher;
    registry: McpHostRouteRegistry;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class McpHostHttpServer {
    readonly #auth?: McpAuthConfig;
    readonly #authMiddleware = new McpAuthMiddleware();
    readonly #handler: McpEndpointRequestHandler;
    readonly #listenHost: string;
    readonly #listenPort: number;
    readonly #matcher: McpHostRouteMatcher;
    readonly #registry: McpHostRouteRegistry;
    #server?: Server;

    constructor(options: McpHostHttpServerOptions) {
        this.#auth = options.auth;
        this.#handler = options.handler;
        this.#listenHost = options.listenHost;
        this.#listenPort = options.listenPort;
        this.#matcher = options.matcher;
        this.#registry = options.registry;
    }

    async start(): Promise<void> {
        if (this.#server !== undefined) {
            return;
        }

        this.#server = createServer((request, response) => {
            void this.#handleRequest(request, response);
        });

        await new Promise<void>((resolve, reject) => {
            this.#server?.once("error", reject);
            this.#server?.listen(this.#listenPort, this.#listenHost, () => resolve());
        });
    }

    async stop(): Promise<void> {
        if (this.#server === undefined) {
            return;
        }

        const server = this.#server;
        this.#server = undefined;
        await new Promise<void>((resolve, reject) => {
            server.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    get address() {
        return this.#server?.address();
    }

    async #handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const match = this.#matcher.match(url.pathname);

        if (match === undefined) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Not found" }));
            return;
        }

        if (!this.#authMiddleware.authorize(request, response, this.#auth)) {
            return;
        }

        const binding = this.#registry.resolve(match.instanceName);

        if (binding === undefined) {
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "Instance not found" }));
            return;
        }

        const body = await this.#readJsonBody(request);
        const result = await this.#handler.handle(binding, body);
        response.writeHead(result.error === undefined ? 200 : 400, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
    }

    async #readJsonBody(request: IncomingMessage): Promise<JsonValue> {
        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }

        if (chunks.length === 0) {
            return {};
        }

        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        return isRecord(value) ? value : {};
    }
}

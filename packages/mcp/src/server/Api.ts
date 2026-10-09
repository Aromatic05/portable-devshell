import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";

/** Capability supplied by the HTTP owner. MCP never owns the TCP listener. */
export interface McpHttpRoute {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>,
    ): () => void;
    registerMiddleware(
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
            next: () => void,
        ) => void | Promise<void>,
    ): () => void;
    registerStaticDirectory(path: string, directory: string): () => void;
    registerUpgradeHandler(
        path: string,
        handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>,
    ): () => void;
    registerUpgradePrefix(
        path: string,
        handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>,
    ): () => void;
}

export interface McpHttpListener extends McpHttpRoute {
    readonly address: AddressInfo | string | null;
    start(): Promise<void>;
    stop(): Promise<void>;
    /** Revoke the HTTP lease permanently after its generation retires. */
    dispose?(): Promise<void>;
}

/** Injected by Control's composition root, not imported from Control. */
export interface McpHttpAccess {
    acquire(address: { listenHost: string; listenPort: number }): McpHttpListener;
}

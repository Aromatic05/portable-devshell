import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";

export type HttpAddress = AddressInfo | string | null;
export type HttpMethod = "delete" | "get" | "head" | "options" | "post";
export type RawHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type MiddlewareHandler = (
    req: IncomingMessage,
    res: ServerResponse,
    next: () => void,
) => void | Promise<void>;
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;

export interface ControlHttpLease {
    start(): Promise<void>;
    stop(): Promise<void>;
    dispose(): Promise<void>;
    readonly address: HttpAddress;
    registerRawRoute(method: HttpMethod, path: string, handler: RawHandler): () => void;
    registerRawPrefix(path: string, handler: RawHandler): () => void;
    registerStaticDirectory(path: string, directory: string): () => void;
    registerUpgradeHandler(path: string, handler: UpgradeHandler): () => void;
    registerUpgradePrefix(path: string, handler: UpgradeHandler): () => void;
    registerMiddleware(path: string, handler: MiddlewareHandler): () => void;
}

export interface ControlHttpServerOptions {
    listenHost: string;
    listenPort: number;
    shutdownGraceMs?: number;
}

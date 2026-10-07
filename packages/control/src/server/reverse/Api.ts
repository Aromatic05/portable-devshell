import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

export interface ReverseHttpHost {
    registerRawRoute(
        method: "delete" | "get" | "head" | "options" | "post",
        path: string,
        handler: (
            request: IncomingMessage,
            response: ServerResponse,
        ) => void | Promise<void>,
    ): () => void;
    registerUpgradeHandler(
        path: string,
        handler: (
            request: IncomingMessage,
            socket: Duplex,
            head: Buffer,
        ) => void | Promise<void>,
    ): () => void;
}

import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import express from "express";
import type { McpHttpRoute } from "../../src/server/Api.ts";

/** Explicit socket-free HTTP simulation for restricted workspaces. Real Node
 * messages/responses, Express and product middleware; no TCP or browser claims. */
export class Round4MemoryHttp implements McpHttpRoute {
    readonly app = express();
    readonly origin = "http://127.0.0.1:19404";
    readonly address = { address: "127.0.0.1", port: 19404, family: "IPv4" };
    async start() {}
    async stop() {}
    registerMiddleware: McpHttpRoute["registerMiddleware"] = (path, handler) => {
        let active = true;
        this.app.use(path, (req, res, next) => {
            if (!active) { next(); return; }
            void handler(req, res, next);
        });
        return () => { active = false; };
    };
    registerRawRoute: McpHttpRoute["registerRawRoute"] = (method, path, handler) => {
        let active = true;
        this.app[method](path, (req, res, next) => {
            if (!active) { next(); return; }
            void handler(req, res);
        });
        return () => { active = false; };
    };
    registerStaticDirectory(): () => void { throw new Error("Round4 memory transport does not serve static files"); }
    registerUpgradeHandler(): () => void { throw new Error("Round4 memory transport does not upgrade sockets"); }
    registerUpgradePrefix(): () => void { throw new Error("Round4 memory transport does not upgrade sockets"); }
    readonly fetch: typeof fetch = async (input, init) => {
        const source = new Request(input, init);
        source.signal.throwIfAborted();
        const url = new URL(source.url);
        const body = source.method === "GET" || source.method === "HEAD" ? "" : await source.text();
        const request = new IncomingMessage(new Socket());
        request.method = source.method;
        request.url = url.pathname + url.search;
        request.headers = Object.fromEntries(source.headers);
        request.headers.host = url.host;
        request.headers["content-length"] = String(Buffer.byteLength(body));
        request.httpVersion = "1.0";
        request.httpVersionMajor = 1;
        request.httpVersionMinor = 0;
        const response = new ServerResponse(request);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const stream = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
        let headerBuffer = Buffer.alloc(0);
        let headersSent = false;
        let finished = false;
        let resolve!: (value: Response) => void;
        let reject!: (reason: unknown) => void;
        const pending = new Promise<Response>((yes, no) => { resolve = yes; reject = no; });
        const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) {
            let bytes = Buffer.from(chunk);
            if (!headersSent) {
                headerBuffer = Buffer.concat([headerBuffer, bytes]);
                const boundary = headerBuffer.indexOf("\r\n\r\n");
                if (boundary < 0) { callback(); return; }
                const headers = new Headers();
                for (const line of headerBuffer.subarray(0, boundary).toString().split("\r\n").slice(1)) {
                    const colon = line.indexOf(":");
                    headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
                }
                bytes = headerBuffer.subarray(boundary + 4);
                headersSent = true;
                resolve(new Response([204, 205, 304].includes(response.statusCode) ? null : stream,
                    { status: response.statusCode, headers }));
            }
            if (bytes.length > 0 && !finished) controller.enqueue(bytes);
            callback();
        } });
        response.assignSocket(socket as Socket);
        const abort = () => {
            if (finished) return;
            finished = true;
            controller.error(source.signal.reason);
            reject(source.signal.reason);
            request.destroy();
            response.destroy();
            socket.destroy();
        };
        source.signal.addEventListener("abort", abort, { once: true });
        response.once("finish", () => {
            if (!finished) { finished = true; controller.close(); }
            source.signal.removeEventListener("abort", abort);
            socket.destroy();
        });
        request.push(body);
        request.push(null);
        this.app(request, response);
        return await pending;
    };
}

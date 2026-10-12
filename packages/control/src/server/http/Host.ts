import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { STATUS_CODES } from "node:http";
import type {
    ControlHttpLease,
    HttpAddress,
    HttpMethod,
    MiddlewareHandler,
    RawHandler,
    UpgradeHandler,
} from "./Api.js";

type Route = {
    kind: "raw" | "prefix" | "static" | "upgrade" | "upgradePrefix" | "middleware";
    path: string;
    method?: HttpMethod;
    handler?: RawHandler | UpgradeHandler | MiddlewareHandler;
    directory?: string;
    active: boolean;
    order?: number;
};
const methods = new Set<HttpMethod>(["delete", "get", "head", "options", "post"]);
const mime: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".wasm": "application/wasm",
    ".mjs": "text/javascript; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".ico": "image/x-icon",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".avif": "image/avif",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".pdf": "application/pdf",
    ".xml": "application/xml",
};

function within(root: string, path: string): boolean {
    return path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
}

function matches(path: string, target: string, prefix: boolean): boolean {
    if (target === "*" || (prefix && target === "/")) return true;
    const wildcard = target.endsWith("/*");
    const base = wildcard ? target.slice(0, -2) : target;
    if (!base.includes(":"))
        return path === base || ((prefix || wildcard) && path.startsWith(`${base.replace(/\/+$/u, "")}/`));
    const pattern = base.split("/");
    const actual = path.split("/");
    if (actual.length < pattern.length || (actual.length !== pattern.length && !(prefix || wildcard)))
        return false;
    return pattern.every((segment, index) =>
        segment.startsWith(":") ? actual[index] !== "" : segment === actual[index],
    );
}

export class Host {
    readonly server: Server;
    #order = 0;
    nextOrder(): number {
        return ++this.#order;
    }
    readonly leases = new Set<Lease>();
    private listening?: Promise<void>;
    private closing?: Promise<void>;
    private sockets = new Set<import("node:stream").Duplex>();
    constructor(
        readonly key: string,
        readonly host: string,
        readonly port: number,
        readonly graceMs: number,
    ) {
        this.server = createServer({ maxHeaderSize: 16 * 1024 }, (req, res) => {
            void this.dispatch(req, res).catch(() => {
                if (!res.headersSent) res.statusCode = 500;
                if (!res.writableEnded) res.end();
            });
        });
        this.server.headersTimeout = 10_000;
        this.server.requestTimeout = 30_000;
        this.server.keepAliveTimeout = 5_000;
        this.server.on("connection", (socket) => {
            this.sockets.add(socket);
            socket.on("close", () => this.sockets.delete(socket));
        });
        this.server.on("upgrade", (req, socket, head) => {
            const route = this.routes().find(
                (x) =>
                    (x.kind === "upgrade" && matches(req.url?.split("?")[0] ?? "/", x.path, false)) ||
                    (x.kind === "upgradePrefix" && matches(req.url?.split("?")[0] ?? "/", x.path, true)),
            );
            if (!route) {
                socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
                return;
            }
            void Promise.resolve()
                .then(() => (route.handler as UpgradeHandler)(req, socket, head))
                .catch(() => socket.destroy());
        });
    }
    private routes(): Route[] {
        return [...this.leases]
            .filter((x) => x.started && !x.disposed)
            .flatMap((x) => x.routes)
            .filter((x) => x.active)
            .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    async start(): Promise<void> {
        if (this.closing) await this.closing;
        if (this.server.listening) return;
        if (!this.listening)
            this.listening = new Promise<void>((resolvePromise, reject) => {
                const fail = (error: Error) => {
                    this.server.off("listening", ready);
                    this.listening = undefined;
                    reject(error);
                };
                const ready = () => {
                    this.server.off("error", fail);
                    resolvePromise();
                };
                this.server.once("error", fail);
                this.server.once("listening", ready);
                try {
                    this.server.listen(this.port, this.host);
                } catch (error) {
                    fail(error as Error);
                }
            });
        await this.listening;
    }
    async stop(lease: Lease): Promise<void> {
        this.leases.delete(lease);
        if (this.leases.size) return;
        if (!this.server.listening) {
            this.listening = undefined;
            return;
        }
        if (!this.closing)
            this.closing = new Promise<void>((resolvePromise) => {
                const timer = setTimeout(() => {
                    for (const socket of this.sockets) socket.destroy();
                }, this.graceMs);
                timer.unref();
                this.server.close(() => {
                    clearTimeout(timer);
                    this.closing = undefined;
                    this.listening = undefined;
                    resolvePromise();
                });
                this.server.closeIdleConnections?.();
            });
        await this.closing;
    }
    private async dispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        const method = req.method?.toLowerCase() as HttpMethod;
        const routes = this.routes().filter((route) => {
            if (route.kind === "middleware" || route.kind === "prefix" || route.kind === "static")
                return matches(path, route.path, true);
            if (route.kind !== "raw") return false;
            return (
                matches(path, route.path, false) &&
                (route.method === method || (method === "head" && route.method === "get"))
            );
        });
        let current = 0;
        const fail = () => {
            if (!res.headersSent) res.statusCode = 500;
            if (!res.writableEnded) res.end();
        };
        const next = (): void => {
            if (res.writableEnded) return;
            const route = routes[current++];
            if (route === undefined) {
                res.statusCode = 404;
                res.end(STATUS_CODES[404]);
                return;
            }
            try {
                if (route.kind === "middleware") {
                    void Promise.resolve((route.handler as MiddlewareHandler)(req, res, next)).catch(fail);
                } else if (route.kind === "static") {
                    void this.serveStatic(req, res, route, path).catch(fail);
                } else {
                    void Promise.resolve((route.handler as RawHandler)(req, res)).catch(fail);
                }
            } catch {
                fail();
            }
        };
        next();
    }
    private async serveStatic(
        req: IncomingMessage,
        res: ServerResponse,
        route: Route,
        requestPath: string,
    ): Promise<void> {
        res.setHeader(
            "content-security-policy",
            "default-src 'self'; base-uri 'none'; connect-src 'self'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
        );
        res.setHeader("referrer-policy", "no-referrer");
        res.setHeader("x-content-type-options", "nosniff");
        if (req.method !== "GET" && req.method !== "HEAD") {
            res.setHeader("allow", "GET, HEAD");
            res.statusCode = 405;
            res.end();
            return;
        }
        if (route.path !== "/" && requestPath === route.path) {
            // Relative Vite assets resolve against the document URL. Serving
            // index.html at /web rather than /web/ makes ./assets point to
            // /assets and leaves the page blank.
            const search = new URL(req.url ?? "/", "http://localhost").search;
            res.statusCode = 308;
            res.setHeader("location", `${route.path}/${search}`);
            res.setHeader("cache-control", "no-cache");
            res.end();
            return;
        }
        const encoded = requestPath.slice(route.path === "/" ? 0 : route.path.length).replace(/^\/+/, "");
        let relative: string;
        try {
            relative = decodeURIComponent(encoded);
            if (relative.includes("\0")) throw new URIError("NUL in static file path");
        } catch {
            res.statusCode = 400;
            res.end();
            return;
        }
        try {
            const root = await realpath(resolve(route.directory!));
            const candidate = resolve(root, relative || "index.html");
            if (!within(root, candidate)) {
                res.statusCode = 403;
                res.end();
                return;
            }
            let file = await realpath(candidate);
            if (!within(root, file)) {
                res.statusCode = 403;
                res.end();
                return;
            }
            if ((await stat(file)).isDirectory()) file = await realpath(resolve(file, "index.html"));
            if (!within(root, file)) {
                res.statusCode = 403;
                res.end();
                return;
            }
            // Check the opened descriptor on Linux to prevent intermediate
            // directory swaps between realpath and open.
            const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            let closeHandle = true;
            try {
                if (process.platform === "linux" && !within(root, await realpath(`/proc/self/fd/${handle.fd}`))) {
                    res.statusCode = 403;
                    res.end();
                    return;
                }
                const info = await handle.stat();
                if (!info.isFile()) {
                    res.statusCode = 404;
                    res.end();
                    return;
                }
                res.setHeader("content-type", mime[extname(file).toLowerCase()] ?? "application/octet-stream");
                res.setHeader(
                    "cache-control",
                    /[/\\]assets[/\\].+\.[A-Za-z0-9]+$/u.test(file)
                        ? "public, max-age=31536000, immutable"
                        : "no-cache",
                );
                res.setHeader("content-length", info.size);
                if (req.method === "HEAD") {
                    res.end();
                    return;
                }
                const stream = handle.createReadStream({ autoClose: true });
                closeHandle = false;
                stream.on("error", (error) => res.destroy(error));
                res.on("close", () => stream.destroy());
                stream.pipe(res);
            } finally {
                if (closeHandle) await handle.close();
            }
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            res.statusCode = code === "EACCES" || code === "EPERM" || code === "ELOOP" ? 403 : 404;
            res.end();
        }
    }
}

export class Lease implements ControlHttpLease {
    readonly routes: Route[] = [];
    started = false;
    disposed = false;
    private starting?: Promise<void>;
    constructor(
        private readonly host: Host,
        private readonly onDisposed: (lease: Lease) => void = () => {},
    ) {}
    get address(): HttpAddress {
        return this.host.server.address() as AddressInfo | string | null;
    }
    async start(): Promise<void> {
        if (this.disposed) throw new Error("HTTP lease has been disposed");
        if (this.started) return;
        if (!this.starting)
            this.starting = (async () => {
                this.host.leases.add(this);
                try {
                    await this.host.start();
                    if (this.disposed) {
                        await this.host.stop(this);
                        throw new Error("HTTP lease has been disposed");
                    }
                    this.started = true;
                } catch (error) {
                    this.host.leases.delete(this);
                    throw error;
                } finally {
                    this.starting = undefined;
                }
            })();
        await this.starting;
    }
    async stop(): Promise<void> {
        if (this.starting) {
            try {
                await this.starting;
            } catch {
                /* startup already rolled back */
            }
        }
        if (!this.started) return;
        this.started = false;
        await this.host.stop(this);
    }
    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        try {
            await this.stop();
        } finally {
            for (const route of this.routes) route.active = false;
            this.routes.length = 0;
            this.onDisposed(this);
        }
    }
    registerRawRoute(method: HttpMethod, path: string, handler: RawHandler): () => void {
        if (!methods.has(method)) throw new Error("Unsupported HTTP method");
        return this.add({ kind: "raw", method, path, handler, active: true });
    }
    registerRawPrefix(path: string, handler: RawHandler): () => void {
        return this.add({ kind: "prefix", path, handler, active: true });
    }
    registerStaticDirectory(path: string, directory: string): () => void {
        return this.add({ kind: "static", path, directory, active: true });
    }
    registerUpgradeHandler(path: string, handler: UpgradeHandler): () => void {
        return this.add({ kind: "upgrade", path, handler, active: true });
    }
    registerUpgradePrefix(path: string, handler: UpgradeHandler): () => void {
        return this.add({ kind: "upgradePrefix", path, handler, active: true });
    }
    registerMiddleware(path: string, handler: MiddlewareHandler): () => void {
        return this.add({ kind: "middleware", path, handler, active: true });
    }
    private add(route: Route): () => void {
        if (this.disposed) throw new Error("HTTP lease has been disposed");
        route.order = this.host.nextOrder();
        this.routes.push(route);
        return () => {
            if (!route.active) return;
            route.active = false;
            const index = this.routes.indexOf(route);
            if (index !== -1) this.routes.splice(index, 1);
        };
    }
}

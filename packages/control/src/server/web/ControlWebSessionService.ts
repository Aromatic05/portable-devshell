import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpHostHttpServer } from "@portable-devshell/mcp";
import { CONTROL_WEB_BASE_PATH } from "@portable-devshell/shared";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 16;
const SESSION_COOKIE_NAME = "devshell_web_session";

export interface ControlWebSessionServiceOptions {
    basePath?: string;
    maxSessions?: number;
    now?: () => number;
    secureCookie?: boolean;
    sessionTtlMs?: number;
    tokenFactory?: () => string;
}

export class ControlWebSessionService {
    readonly #basePath: string;
    readonly #expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #maxSessions: number;
    readonly #now: () => number;
    readonly #revocationListeners = new Set<(token: string) => void>();
    readonly #secureCookie: boolean;
    readonly #sessionTtlMs: number;
    readonly #tokenFactory: () => string;
    readonly #sessions = new Map<string, number>();
    #installed = false;

    constructor(options: ControlWebSessionServiceOptions = {}) {
        this.#basePath = normalizeBasePath(options.basePath ?? CONTROL_WEB_BASE_PATH);
        this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) {
            throw new Error("Control web maxSessions must be a positive safe integer.");
        }
        this.#now = options.now ?? Date.now;
        this.#secureCookie = options.secureCookie ?? false;
        this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
        if (!Number.isSafeInteger(this.#sessionTtlMs) || this.#sessionTtlMs < 1) {
            throw new Error("Control web sessionTtlMs must be a positive safe integer.");
        }
        this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    }

    install(http: McpHostHttpServer): void {
        if (this.#installed) {
            return;
        }
        this.#installed = true;
        const sessionPath = `${this.#basePath}/session`;
        http.registerAuthenticatedRawRoute("post", sessionPath, (_request, response) => {
            this.#create(response);
        });
        http.registerRawRoute("get", sessionPath, (request, response) => {
            if (!this.authorize(request)) {
                writeJsonError(response, 401, "Unauthorized");
                return;
            }
            writeNoContent(response);
        });
        http.registerRawRoute("delete", sessionPath, (request, response) => {
            this.#revoke(request);
            response.setHeader("Set-Cookie", this.#cookie("", 0));
            writeNoContent(response);
        });
    }

    authorize(request: IncomingMessage): boolean {
        return this.authorizeToken(request) !== undefined;
    }

    authorizeToken(request: IncomingMessage): string | undefined {
        this.#prune();
        const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
        if (token === undefined) {
            return undefined;
        }
        const expiresAt = this.#sessions.get(token);
        if (expiresAt === undefined || expiresAt <= this.#now()) {
            this.#deleteSession(token);
            return undefined;
        }
        return token;
    }

    onRevoked(listener: (token: string) => void): () => void {
        this.#revocationListeners.add(listener);
        return () => this.#revocationListeners.delete(listener);
    }

    clear(): void {
        for (const token of [...this.#sessions.keys()]) {
            this.#deleteSession(token);
        }
    }

    #create(response: ServerResponse): void {
        this.#prune();
        while (this.#sessions.size >= this.#maxSessions) {
            const oldest = this.#sessions.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.#deleteSession(oldest);
        }
        const token = this.#tokenFactory();
        this.#deleteSession(token);
        const expiresAt = this.#now() + this.#sessionTtlMs;
        this.#sessions.set(token, expiresAt);
        const expiryTimer = setTimeout(() => {
            this.#deleteSession(token);
        }, this.#sessionTtlMs);
        expiryTimer.unref?.();
        this.#expiryTimers.set(token, expiryTimer);
        response.setHeader(
            "Set-Cookie",
            this.#cookie(token, Math.max(1, Math.floor(this.#sessionTtlMs / 1_000)))
        );
        writeNoContent(response);
    }

    #revoke(request: IncomingMessage): void {
        const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
        if (token !== undefined) {
            this.#deleteSession(token);
        }
    }

    #prune(): void {
        const now = this.#now();
        for (const [token, expiresAt] of this.#sessions) {
            if (expiresAt <= now) {
                this.#deleteSession(token);
            }
        }
    }

    #deleteSession(token: string): void {
        if (!this.#sessions.delete(token)) {
            return;
        }
        const expiryTimer = this.#expiryTimers.get(token);
        if (expiryTimer !== undefined) {
            clearTimeout(expiryTimer);
            this.#expiryTimers.delete(token);
        }
        for (const listener of [...this.#revocationListeners]) {
            try {
                listener(token);
            } catch (error) {
                console.warn(error instanceof Error ? error : new Error(String(error)));
            }
        }
    }

    #cookie(value: string, maxAgeSeconds: number): string {
        return [
            `${SESSION_COOKIE_NAME}=${value}`,
            `Path=${this.#basePath}`,
            "HttpOnly",
            "SameSite=Strict",
            `Max-Age=${maxAgeSeconds}`,
            ...(this.#secureCookie ? ["Secure"] : [])
        ].join("; ");
    }
}

function normalizeBasePath(value: string): string {
    if (!value.startsWith("/") || value === "/") {
        throw new Error("Control web basePath must be an absolute non-root path.");
    }
    return value.replace(/\/+$/u, "");
}

function readCookie(header: string | undefined, name: string): string | undefined {
    if (header === undefined) {
        return undefined;
    }
    for (const segment of header.split(";")) {
        const separator = segment.indexOf("=");
        if (separator < 0) {
            continue;
        }
        if (segment.slice(0, separator).trim() !== name) {
            continue;
        }
        const value = segment.slice(separator + 1).trim();
        return value.length === 0 ? undefined : value;
    }
    return undefined;
}

function writeNoContent(response: ServerResponse): void {
    response.statusCode = 204;
    response.setHeader("Cache-Control", "no-store");
    response.end();
}

function writeJsonError(response: ServerResponse, statusCode: number, message: string): void {
    const body = JSON.stringify({ error: message });
    response.statusCode = statusCode;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", Buffer.byteLength(body));
    response.end(body);
}

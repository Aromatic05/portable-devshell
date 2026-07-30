import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { McpHostHttpServer } from "@portable-devshell/mcp";
import { CONTROL_WEB_SESSION_PATH } from "@portable-devshell/shared";

const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;
const DEFAULT_MAX_SESSIONS = 16;
const SESSION_COOKIE_NAME = "devshell_web_session";
const SESSION_COOKIE_PATH = "/web";

export interface ControlWebSessionServiceOptions {
    maxSessions?: number;
    now?: () => number;
    secureCookie?: boolean;
    sessionTtlMs?: number;
    tokenFactory?: () => string;
}

export class ControlWebSessionService {
    readonly #maxSessions: number;
    readonly #now: () => number;
    readonly #secureCookie: boolean;
    readonly #sessionTtlMs: number;
    readonly #tokenFactory: () => string;
    readonly #sessions = new Map<string, number>();
    #installed = false;

    constructor(options: ControlWebSessionServiceOptions = {}) {
        this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
        if (!Number.isSafeInteger(this.#maxSessions) || this.#maxSessions < 1) {
            throw new Error("Control web maxSessions must be a positive safe integer.");
        }
        this.#now = options.now ?? Date.now;
        this.#secureCookie = options.secureCookie ?? false;
        this.#sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
        this.#tokenFactory = options.tokenFactory ?? (() => randomBytes(32).toString("base64url"));
    }

    install(http: McpHostHttpServer): void {
        if (this.#installed) {
            return;
        }
        this.#installed = true;
        http.registerAuthenticatedRawRoute("post", CONTROL_WEB_SESSION_PATH, (_request, response) => {
            this.#create(response);
        });
        http.registerRawRoute("get", CONTROL_WEB_SESSION_PATH, (request, response) => {
            if (!this.authorize(request)) {
                writeJsonError(response, 401, "Unauthorized");
                return;
            }
            writeNoContent(response);
        });
        http.registerRawRoute("delete", CONTROL_WEB_SESSION_PATH, (request, response) => {
            this.#revoke(request);
            response.setHeader("Set-Cookie", this.#cookie("", 0));
            writeNoContent(response);
        });
    }

    authorize(request: IncomingMessage): boolean {
        this.#prune();
        const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
        if (token === undefined) {
            return false;
        }
        const expiresAt = this.#sessions.get(token);
        if (expiresAt === undefined || expiresAt <= this.#now()) {
            this.#sessions.delete(token);
            return false;
        }
        return true;
    }

    clear(): void {
        this.#sessions.clear();
    }

    #create(response: ServerResponse): void {
        this.#prune();
        while (this.#sessions.size >= this.#maxSessions) {
            const oldest = this.#sessions.keys().next().value as string | undefined;
            if (oldest === undefined) {
                break;
            }
            this.#sessions.delete(oldest);
        }
        const token = this.#tokenFactory();
        const expiresAt = this.#now() + this.#sessionTtlMs;
        this.#sessions.set(token, expiresAt);
        response.setHeader(
            "Set-Cookie",
            this.#cookie(token, Math.max(1, Math.floor(this.#sessionTtlMs / 1_000)))
        );
        writeNoContent(response);
    }

    #revoke(request: IncomingMessage): void {
        const token = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
        if (token !== undefined) {
            this.#sessions.delete(token);
        }
    }

    #prune(): void {
        const now = this.#now();
        for (const [token, expiresAt] of this.#sessions) {
            if (expiresAt <= now) {
                this.#sessions.delete(token);
            }
        }
    }

    #cookie(value: string, maxAgeSeconds: number): string {
        return [
            `${SESSION_COOKIE_NAME}=${value}`,
            `Path=${SESSION_COOKIE_PATH}`,
            "HttpOnly",
            "SameSite=Strict",
            `Max-Age=${maxAgeSeconds}`,
            ...(this.#secureCookie ? ["Secure"] : [])
        ].join("; ");
    }
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

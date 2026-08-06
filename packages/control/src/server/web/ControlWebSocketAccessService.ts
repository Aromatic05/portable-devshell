import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { CONTROL_REMOTE_BEARER_SUBPROTOCOL_PREFIX } from "@portable-devshell/shared";

import type { ControlWebSessionService } from "./ControlWebSessionService.js";

export interface ControlWebSocketAccess {
    key: string;
    kind: "browser" | "native";
}

export interface ControlWebSocketAccessAuthorizer {
    authorize(request: IncomingMessage): Promise<ControlWebSocketAccess | undefined>;
    onRevoked(listener: (key: string) => void): () => void;
}

export interface ControlWebSocketAccessServiceOptions {
    sessions: ControlWebSessionService;
    verifyBearer?: (
        token: string
    ) => Promise<{ clientId?: string; scopes?: string[] } | boolean>;
}

export class ControlWebSocketAccessService implements ControlWebSocketAccessAuthorizer {
    readonly #sessions: ControlWebSessionService;
    readonly #verifyBearer?: ControlWebSocketAccessServiceOptions["verifyBearer"];

    constructor(options: ControlWebSocketAccessServiceOptions) {
        this.#sessions = options.sessions;
        this.#verifyBearer = options.verifyBearer;
    }

    async authorize(request: IncomingMessage): Promise<ControlWebSocketAccess | undefined> {
        const sessionToken = this.#sessions.authorizeToken(request);
        if (sessionToken !== undefined) {
            return { key: sessionKey(sessionToken), kind: "browser" };
        }

        const token = readBearerToken(request);
        const auth = this.#sessions.auth;
        if (auth.mode === "none") {
            return undefined;
        }
        if (token === undefined) return undefined;
        if (auth.mode === "token") {
            return constantTimeEquals(token, auth.token)
                ? { key: nativeKey(token), kind: "native" }
                : undefined;
        }
        if (this.#verifyBearer === undefined) return undefined;
        try {
            const verified = await this.#verifyBearer(token);
            return verified === false
                ? undefined
                : { key: nativeKey(token), kind: "native" };
        } catch {
            return undefined;
        }
    }

    onRevoked(listener: (key: string) => void): () => void {
        return this.#sessions.onRevoked((token) => listener(sessionKey(token)));
    }
}

export class ControlWebSocketSessionAccess implements ControlWebSocketAccessAuthorizer {
    constructor(private readonly sessions: ControlWebSessionService) {}

    async authorize(request: IncomingMessage): Promise<ControlWebSocketAccess | undefined> {
        const token = this.sessions.authorizeToken(request);
        return token === undefined
            ? undefined
            : { key: sessionKey(token), kind: "browser" };
    }

    onRevoked(listener: (key: string) => void): () => void {
        return this.sessions.onRevoked((token) => listener(sessionKey(token)));
    }
}

function sessionKey(token: string): string {
    return `session:${createHash("sha256").update(token).digest("hex")}`;
}

function nativeKey(token: string): string {
    return `native:${createHash("sha256").update(token).digest("hex")}`;
}

function readBearerToken(request: IncomingMessage): string | undefined {
    const authorization = /^Bearer[ \t]+([^ \t]+)$/iu.exec(
        request.headers.authorization ?? ""
    )?.[1];
    if (authorization !== undefined) return authorization;
    const protocols = request.headers["sec-websocket-protocol"];
    const value = Array.isArray(protocols) ? protocols.join(",") : protocols;
    const encoded = value?.split(",")
        .map((protocol) => protocol.trim())
        .find((protocol) => protocol.startsWith(CONTROL_REMOTE_BEARER_SUBPROTOCOL_PREFIX))
        ?.slice(CONTROL_REMOTE_BEARER_SUBPROTOCOL_PREFIX.length);
    if (encoded === undefined || encoded.length === 0) return undefined;
    try {
        return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
        return undefined;
    }
}

function constantTimeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, "utf8");
    const rightBuffer = Buffer.from(right, "utf8");
    if (leftBuffer.length !== rightBuffer.length) return false;
    return timingSafeEqual(leftBuffer, rightBuffer);
}

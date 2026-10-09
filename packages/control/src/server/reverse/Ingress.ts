import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import {
    createRemoteError,
    controlErrorCodes,
    WebServerChannel,
    type JsonValue,
    type ReverseEnrollmentRequest,
    type ReverseUpstreamBatch,
    ReverseSseChannel,
    runtimeErrorCodes,
} from "@portable-devshell/shared";
import {
    ReverseConnections,
    type ReverseConnectionIdentity,
} from "@portable-devshell/core";
import { WebSocketServer } from "ws";

import type { ReverseCredentials } from "../../instance/reverse/Credentials.js";
import type { ReverseHttpHost } from "./Api.js";

const ENROLL_SUFFIX = "/reverse/v1/enroll";
const WSS_SUFFIX = "/reverse/v1/connect";
const SSE_SUFFIX = "/reverse/v1/events";
const UPSTREAM_SUFFIX = "/reverse/v1/frames";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface ReverseAuthentication {
    readonly identity: ReverseConnectionIdentity;
    readonly token: string;
}

export interface ReverseIngressOptions {
    connections: ReverseConnections;
    credentials: ReverseCredentials;
    publicBaseUrl: string;
}

export class ReverseIngress {
    readonly #connections: ReverseConnections;
    readonly #credentials: ReverseCredentials;
    #publicBaseUrl: string;
    #unregisterRoutes: Array<() => void> = [];
    readonly #webSocketServer = new WebSocketServer({
        clientTracking: false,
        noServer: true,
    });

    constructor(options: ReverseIngressOptions) {
        this.#connections = options.connections;
        this.#credentials = options.credentials;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    setPublicBaseUrl(publicBaseUrl: string): void {
        this.#publicBaseUrl = publicBaseUrl;
    }

    install(server: ReverseHttpHost): void {
        this.#unregister();
        try {
            const enrollPath = reverseRoute(this.#publicBaseUrl, ENROLL_SUFFIX);
            const ssePath = reverseRoute(this.#publicBaseUrl, SSE_SUFFIX);
            const upstreamPath = reverseRoute(this.#publicBaseUrl, UPSTREAM_SUFFIX);
            const wssPath = reverseRoute(this.#publicBaseUrl, WSS_SUFFIX);

            this.#unregisterRoutes.push(server.registerRawRoute(
                "post",
                enrollPath,
                async (request, response) => {
                    await this.#handleEnroll(request, response);
                },
            ));
            this.#unregisterRoutes.push(server.registerRawRoute("get", ssePath, async (request, response) => {
                await this.#handleSse(request, response);
            }));
            this.#unregisterRoutes.push(server.registerRawRoute(
                "post",
                upstreamPath,
                async (request, response) => {
                    await this.#handleUpstream(request, response);
                },
            ));
            this.#unregisterRoutes.push(server.registerUpgradeHandler(
                wssPath,
                async (request, socket, head) => {
                    await this.#handleWebSocketUpgrade(request, socket, head);
                },
            ));
        } catch (error) {
            this.#unregister();
            throw error;
        }
    }

    stop(): void {
        this.#unregister();
        this.#webSocketServer.close();
    }

    #unregister(): void {
        for (const remove of this.#unregisterRoutes.splice(0).reverse()) remove();
    }

    async #handleEnroll(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        try {
            const body = asEnrollmentRequest(await readJsonBody(request));
            const credential = await this.#credentials.consumeDeviceCode(
                body.deviceCode,
            );
            sendJson(response, 200, {
                controllerUrl: this.#publicBaseUrl,
                ...credential,
            });
        } catch (error) {
            sendGatewayError(response, error);
        }
    }

    async #handleWebSocketUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer,
    ): Promise<void> {
        try {
            const authentication = await this.#authenticateRequest(request);
            if (
                !hasWebSocketProtocol(request, "devshell-worker-transport.v1")
            ) {
                throw createRemoteError({
                    code: runtimeErrorCodes.reverseTransportUnavailable,
                    message:
                        "Sec-WebSocket-Protocol devshell-worker-transport.v1 is required.",
                    retryable: false,
                });
            }

            this.#webSocketServer.handleUpgrade(
                request,
                socket,
                head,
                (webSocket) => {
                    const channel = new WebServerChannel(webSocket as never);
                    void this.#credentials
                        .runAuthenticated(
                            authentication.identity.descriptor.config.name,
                            authentication.token,
                            async () =>
                                await this.#connections.activate(
                                    authentication.identity,
                                    "wss",
                                    channel,
                                ),
                        )
                        .catch(() => channel.close());
                },
            );
        } catch (error) {
            writeUpgradeError(socket, error);
        }
    }

    async #handleSse(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        try {
            const authentication = await this.#authenticateRequest(request);
            response.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no",
            });
            response.flushHeaders();
            const channel = new ReverseSseChannel(
                response,
                readLastEventId(request),
            );
            await this.#credentials.runAuthenticated(
                authentication.identity.descriptor.config.name,
                authentication.token,
                async () =>
                    await this.#connections.activate(
                        authentication.identity,
                        "sse",
                        channel,
                    ),
            );
        } catch (error) {
            if (!response.headersSent) {
                sendGatewayError(response, error);
            } else if (!response.writableEnded) {
                try {
                    response.end();
                } catch {
                    // The SSE channel may already own a closed response.
                }
            }
        }
    }

    async #handleUpstream(
        request: IncomingMessage,
        response: ServerResponse,
    ): Promise<void> {
        try {
            const authentication = await this.#authenticateRequest(request);
            const batch = asUpstreamBatch(await readJsonBody(request));
            sendJson(
                response,
                200,
                this.#connections.acceptUpstream(
                    authentication.identity,
                    batch,
                ),
            );
        } catch (error) {
            sendGatewayError(response, error);
        }
    }

    async #authenticateRequest(
        request: IncomingMessage,
    ): Promise<ReverseAuthentication> {
        const instance = readRequiredHeader(request, "x-devshell-instance");
        const generation = parseGeneration(
            readRequiredHeader(request, "x-devshell-generation"),
        );
        const token = readBearerToken(request.headers.authorization);
        const descriptor = await this.#credentials.authenticate(instance, token);
        return {
            identity: { descriptor, generation },
            token,
        };
    }
}
function asEnrollmentRequest(value: JsonValue): ReverseEnrollmentRequest {
    if (!isRecord(value)) {
        throw new Error("Enrollment body must be an object.");
    }
    return {
        arch: readString(value.arch, "arch"),
        deviceCode: readString(value.deviceCode, "deviceCode"),
        os: readString(value.os, "os"),
        workerVersion: readString(value.workerVersion, "workerVersion"),
    };
}

function asUpstreamBatch(value: JsonValue): ReverseUpstreamBatch {
    if (
        !isRecord(value) ||
        !Number.isSafeInteger(value.generation) ||
        !Array.isArray(value.frames)
    ) {
        throw new Error("Invalid reverse upstream batch.");
    }
    return {
        generation: value.generation as number,
        frames: value.frames.map((frame) => {
            if (
                !isRecord(frame) ||
                !Number.isSafeInteger(frame.seq) ||
                typeof frame.frame !== "string"
            ) {
                throw new Error("Invalid reverse upstream frame.");
            }
            return {
                frame: frame.frame,
                seq: frame.seq as number,
            };
        }),
    };
}

async function readJsonBody(request: IncomingMessage): Promise<JsonValue> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.byteLength;
        if (size > MAX_JSON_BODY_BYTES) {
            throw new Error("Request body is too large.");
        }
        chunks.push(buffer);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
}

function readRequiredHeader(request: IncomingMessage, name: string): string {
    const value = request.headers[name];
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`Header ${name} is required.`);
    }
    return value;
}

function readBearerToken(authorization: string | undefined): string {
    const match = /^Bearer\s+(.+)$/iu.exec(authorization ?? "");
    if (match?.[1] === undefined) {
        throw createRemoteError({
            code: runtimeErrorCodes.reverseDeviceTokenInvalid,
            message: "Bearer device token is required.",
            retryable: false,
        });
    }
    return match[1];
}

function parseGeneration(value: string): number {
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw createRemoteError({
            code: runtimeErrorCodes.reverseGenerationInvalid,
            message: "Connection generation must be a positive integer.",
            retryable: false,
        });
    }
    return generation;
}

function readLastEventId(request: IncomingMessage): number {
    const raw =
        request.headers["last-event-id"] ??
        request.headers["x-devshell-downstream-ack"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined) return 0;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function hasWebSocketProtocol(
    request: IncomingMessage,
    expected: string,
): boolean {
    const header = request.headers["sec-websocket-protocol"];
    return (
        typeof header === "string" &&
        header.split(",").some((value) => value.trim() === expected)
    );
}

function sendJson(
    response: ServerResponse,
    status: number,
    body: JsonValue,
): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

function sendGatewayError(response: ServerResponse, error: unknown): void {
    const code = readErrorCode(error);
    const status =
        code === controlErrorCodes.instanceNotFound
            ? 404
            : code === runtimeErrorCodes.reverseDeviceTokenInvalid ||
                code === runtimeErrorCodes.reverseDeviceTokenRevoked
              ? 401
              : code === runtimeErrorCodes.reverseConnectionSuperseded ||
                  code === runtimeErrorCodes.reverseGenerationInvalid
                ? 409
                : 400;
    sendJson(response, status, {
        error: {
            code,
            message: error instanceof Error ? error.message : String(error),
        },
    });
}

function writeUpgradeError(socket: Duplex, error: unknown): void {
    const code = readErrorCode(error);
    const status =
        code === runtimeErrorCodes.reverseDeviceTokenInvalid
            ? "401 Unauthorized"
            : "409 Conflict";
    socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(
            {
                error: {
                    code,
                    message:
                        error instanceof Error ? error.message : String(error),
                },
            },
        )}`,
    );
}

function readErrorCode(error: unknown): string {
    return typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
        ? error.code
        : runtimeErrorCodes.reverseFrameInvalid;
}

export function reverseRoute(publicBaseUrl: string, suffix: string): string {
    const url = new URL(publicBaseUrl);
    const basePath =
        url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
    return `${basePath}/${suffix.replace(/^\//u, "")}`;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: JsonValue | undefined, field: string): string {
    if (typeof value !== "string" || value.length === 0) {
        throw new Error(`${field} must be a non-empty string.`);
    }
    return value;
}

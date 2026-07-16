import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

import type { WorkerRpcChannel } from "@portable-devshell/core";
import type { McpHostHttpServer } from "@portable-devshell/mcp";
import {
    createError,
    errorCodes,
    type JsonValue,
    type ReverseEnrollmentRequest,
    type ReverseUpstreamBatch
} from "@portable-devshell/shared";
import { WebSocketServer } from "ws";

import type { ReverseInstanceLookupPort, ReverseInstancePort } from "./ReverseInstancePort.js";
import { ReverseCredentialStore } from "./ReverseCredentialStore.js";
import { ReverseRpcSseChannel } from "./rpc/ReverseRpcSseChannel.js";
import { ReverseRpcWebSocketChannel } from "./rpc/ReverseRpcWebSocketChannel.js";

const ENROLL_SUFFIX = "/reverse/v1/enroll";
const WSS_SUFFIX = "/reverse/v1/connect";
const SSE_SUFFIX = "/reverse/v1/events";
const UPSTREAM_SUFFIX = "/reverse/v1/frames";
const MAX_JSON_BODY_BYTES = 1024 * 1024;

interface ActiveReverseConnection {
    channel: WorkerRpcChannel;
    generation: number;
    transport: "sse" | "wss";
}

export interface ReverseConnectionGatewayOptions {
    credentialStore: ReverseCredentialStore;
    instanceRegistry: ReverseInstanceLookupPort;
    publicBaseUrl: string;
}

export class ReverseConnectionGateway {
    readonly #credentialStore: ReverseCredentialStore;
    readonly #instanceRegistry: ReverseInstanceLookupPort;
    readonly #publicBaseUrl: string;
    readonly #webSocketServer = new WebSocketServer({ clientTracking: false, noServer: true });
    readonly #active = new Map<string, ActiveReverseConnection>();
    readonly #activationQueues = new Map<string, Promise<unknown>>();

    constructor(options: ReverseConnectionGatewayOptions) {
        this.#credentialStore = options.credentialStore;
        this.#instanceRegistry = options.instanceRegistry;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    install(server: McpHostHttpServer): void {
        const enrollPath = reverseRoute(this.#publicBaseUrl, ENROLL_SUFFIX);
        const ssePath = reverseRoute(this.#publicBaseUrl, SSE_SUFFIX);
        const upstreamPath = reverseRoute(this.#publicBaseUrl, UPSTREAM_SUFFIX);
        const wssPath = reverseRoute(this.#publicBaseUrl, WSS_SUFFIX);

        server.registerRawRoute("post", enrollPath, async (request, response) => {
            await this.#handleEnroll(request, response);
        });
        server.registerRawRoute("get", ssePath, async (request, response) => {
            await this.#handleSse(request, response);
        });
        server.registerRawRoute("post", upstreamPath, async (request, response) => {
            await this.#handleUpstream(request, response);
        });
        server.registerUpgradeHandler(wssPath, async (request, socket, head) => {
            await this.#handleWebSocketUpgrade(request, socket, head);
        });
    }

    disconnect(instance: string): void {
        const active = this.#active.get(instance);
        if (active === undefined) {
            return;
        }
        this.#active.delete(instance);
        active.channel.close();
    }

    stop(): void {
        for (const active of this.#active.values()) {
            active.channel.close();
        }
        this.#active.clear();
        this.#webSocketServer.close();
    }

    async #handleEnroll(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const body = asEnrollmentRequest(await readJsonBody(request));
            const credential = await this.#credentialStore.consumeDeviceCode(body.deviceCode);
            const descriptor = this.#requireReverseInstance(credential.instance);
            await descriptor.worker.setReverseEnrollmentState("enrolled");
            this.disconnect(descriptor.name);
            sendJson(response, 200, {
                controllerUrl: this.#publicBaseUrl,
                deviceToken: credential.deviceToken,
                instance: descriptor.name,
                workspace: descriptor.workspace ?? ""
            });
        } catch (error) {
            sendGatewayError(response, error);
        }
    }

    async #handleWebSocketUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        head: Buffer
    ): Promise<void> {
        try {
            const identity = await this.#authenticateRequest(request);
            if (!hasWebSocketProtocol(request, "devshell-worker-rpc.v1")) {
                throw createError({
                    code: errorCodes.reverseTransportUnavailable,
                    message: "Sec-WebSocket-Protocol devshell-worker-rpc.v1 is required.",
                    retryable: false
                });
            }
            this.#webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
                const channel = new ReverseRpcWebSocketChannel(webSocket);
                void this.#activate(identity.descriptor, identity.generation, "wss", channel).catch((error) => {
                    webSocket.close(1008, error instanceof Error ? error.message.slice(0, 120) : "activation failed");
                });
            });
        } catch (error) {
            writeUpgradeError(socket, error);
        }
    }

    async #handleSse(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const identity = await this.#authenticateRequest(request);
            response.writeHead(200, {
                "Cache-Control": "no-cache, no-transform",
                Connection: "keep-alive",
                "Content-Type": "text/event-stream",
                "X-Accel-Buffering": "no"
            });
            response.flushHeaders();
            const channel = new ReverseRpcSseChannel(response, readLastEventId(request));
            await this.#activate(identity.descriptor, identity.generation, "sse", channel);
        } catch (error) {
            if (!response.headersSent) {
                sendGatewayError(response, error);
            } else if (!response.writableEnded) {
                response.end();
            }
        }
    }

    async #handleUpstream(request: IncomingMessage, response: ServerResponse): Promise<void> {
        try {
            const identity = await this.#authenticateRequest(request);
            const batch = asUpstreamBatch(await readJsonBody(request));
            if (batch.generation !== identity.generation) {
                throw createError({
                    code: errorCodes.reverseGenerationInvalid,
                    message: "Upstream generation does not match request generation.",
                    retryable: true
                });
            }
            const active = this.#active.get(identity.descriptor.name);
            if (
                active === undefined ||
                active.transport !== "sse" ||
                active.generation !== identity.generation ||
                !(active.channel instanceof ReverseRpcSseChannel)
            ) {
                throw createError({
                    code: errorCodes.reverseConnectionSuperseded,
                    message: "SSE connection is not the active generation.",
                    retryable: true
                });
            }

            let acceptedThrough = active.channel.acceptedUpstreamSeq;
            for (const frame of batch.frames) {
                acceptedThrough = active.channel.acceptUpstream(frame.seq, frame.frame);
            }
            sendJson(response, 200, {
                acceptedThrough,
                generation: identity.generation
            });
        } catch (error) {
            sendGatewayError(response, error);
        }
    }

    async #authenticateRequest(request: IncomingMessage): Promise<{
        descriptor: ReverseInstancePort;
        generation: number;
    }> {
        const instance = readRequiredHeader(request, "x-devshell-instance");
        const generation = parseGeneration(readRequiredHeader(request, "x-devshell-generation"));
        const token = readBearerToken(request.headers.authorization);
        const authenticated = await this.#credentialStore.authenticate(instance, token);
        if (!authenticated) {
            throw createError({
                code: errorCodes.reverseDeviceTokenInvalid,
                details: { instance },
                message: "Device token is invalid or revoked.",
                retryable: false
            });
        }
        return {
            descriptor: this.#requireReverseInstance(instance),
            generation
        };
    }

    async #activate(
        descriptor: ReverseInstancePort,
        generation: number,
        transport: "sse" | "wss",
        channel: WorkerRpcChannel
    ): Promise<void> {
        await this.#exclusive(descriptor.name, async () => {
            const previous = this.#active.get(descriptor.name);
            const previousGeneration = Math.max(
                previous?.generation ?? 0,
                descriptor.worker.snapshot().reverse?.generation ?? 0
            );
            if (!Number.isSafeInteger(generation) || generation <= previousGeneration) {
                channel.close();
                throw createError({
                    code: errorCodes.reverseGenerationInvalid,
                    details: { generation, instance: descriptor.name, previousGeneration },
                    message: `Connection generation must be greater than ${previousGeneration}.`,
                    retryable: true
                });
            }

            const active: ActiveReverseConnection = { channel, generation, transport };
            this.#active.set(descriptor.name, active);
            channel.onDisconnect(() => {
                if (this.#active.get(descriptor.name) === active) {
                    this.#active.delete(descriptor.name);
                }
            });

            try {
                await descriptor.worker.acceptReverseChannel(channel, { generation, transport });
            } catch (error) {
                if (this.#active.get(descriptor.name) === active) {
                    this.#active.delete(descriptor.name);
                }
                channel.close();
                throw error;
            }
        });
    }

    #requireReverseInstance(instance: string): ReverseInstancePort {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance },
                message: `Instance ${instance} was not found.`,
                retryable: false
            });
        }
        if (descriptor.provider !== "reverse" || descriptor.reverseConnector === undefined) {
            throw createError({
                code: errorCodes.reverseInstanceNotReverse,
                details: { instance },
                message: `Instance ${instance} is not configured for reverse connections.`,
                retryable: false
            });
        }
        return descriptor;
    }

    async #exclusive<T>(instance: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.#activationQueues.get(instance) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        const tracked = next.finally(() => {
            if (this.#activationQueues.get(instance) === tracked) {
                this.#activationQueues.delete(instance);
            }
        });
        this.#activationQueues.set(instance, tracked);
        return await next;
    }
}

function asEnrollmentRequest(value: JsonValue): ReverseEnrollmentRequest {
    if (!isRecord(value)) {
        throw new Error("Enrollment body must be an object.");
    }
    const deviceCode = readString(value.deviceCode, "deviceCode");
    return {
        arch: readString(value.arch, "arch"),
        deviceCode,
        os: readString(value.os, "os"),
        workerVersion: readString(value.workerVersion, "workerVersion")
    };
}

function asUpstreamBatch(value: JsonValue): ReverseUpstreamBatch {
    if (!isRecord(value) || !Number.isSafeInteger(value.generation) || !Array.isArray(value.frames)) {
        throw new Error("Invalid reverse upstream batch.");
    }
    return {
        generation: value.generation as number,
        frames: value.frames.map((frame) => {
            if (!isRecord(frame) || !Number.isSafeInteger(frame.seq) || typeof frame.frame !== "string") {
                throw new Error("Invalid reverse upstream frame.");
            }
            return { frame: frame.frame, seq: frame.seq as number };
        })
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
        throw createError({
            code: errorCodes.reverseDeviceTokenInvalid,
            message: "Bearer device token is required.",
            retryable: false
        });
    }
    return match[1];
}

function parseGeneration(value: string): number {
    const generation = Number(value);
    if (!Number.isSafeInteger(generation) || generation <= 0) {
        throw createError({
            code: errorCodes.reverseGenerationInvalid,
            message: "Connection generation must be a positive integer.",
            retryable: false
        });
    }
    return generation;
}

function readLastEventId(request: IncomingMessage): number {
    const raw = request.headers["last-event-id"] ?? request.headers["x-devshell-downstream-ack"];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined) {
        return 0;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function hasWebSocketProtocol(request: IncomingMessage, expected: string): boolean {
    const header = request.headers["sec-websocket-protocol"];
    return typeof header === "string" && header.split(",").some((value) => value.trim() === expected);
}

function sendJson(response: ServerResponse, status: number, body: JsonValue): void {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

function sendGatewayError(response: ServerResponse, error: unknown): void {
    const code = readErrorCode(error);
    const status =
        code === errorCodes.instanceMissing
            ? 404
            : code === errorCodes.reverseDeviceTokenInvalid || code === errorCodes.reverseDeviceTokenRevoked
              ? 401
              : code === errorCodes.reverseConnectionSuperseded || code === errorCodes.reverseGenerationInvalid
                ? 409
                : 400;
    sendJson(response, status, {
        error: {
            code,
            message: error instanceof Error ? error.message : String(error)
        }
    });
}

function writeUpgradeError(socket: Duplex, error: unknown): void {
    const code = readErrorCode(error);
    const status = code === errorCodes.reverseDeviceTokenInvalid ? "401 Unauthorized" : "409 Conflict";
    socket.end(
        `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({
            error: { code, message: error instanceof Error ? error.message : String(error) }
        })}`
    );
}

function readErrorCode(error: unknown): string {
    return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : errorCodes.reverseFrameInvalid;
}

export function reverseRoute(publicBaseUrl: string, suffix: string): string {
    const url = new URL(publicBaseUrl);
    const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/u, "");
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

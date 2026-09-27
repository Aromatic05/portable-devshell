import {
    CONTROL_PROTOCOL_LEGACY_VERSION,
    CONTROL_PROTOCOL_VERSION,
    Codec,
    PrefixRoute,
    createError,
    errorCodes,
} from "@portable-devshell/shared";
import type {
    Channel,
    ControlClientKind,
    ControlProtocolHelloResponse,
    JsonValue,
    PrefixRouteIncoming,
    PrefixRouteModuleDefinition,
    PrefixRouteSnapshot,
    PrefixRouteSubject,
} from "@portable-devshell/shared";
import { routeModule } from "../Route.js";

export interface ControlChannelRouteProvider {
    connectionClosed(connectionId: string): void;
    snapshot(): PrefixRouteSnapshot;
}

export interface ControlChannelListener {
    start(accept: (connection: ControlAcceptedChannel) => void): Promise<void>;
    close(): Promise<void>;
}

export interface ControlChannelAdmission {
    readonly allowedPeers: readonly ControlClientKind[];
    readonly subject: PrefixRouteSubject;
}

export interface ControlAcceptedChannel {
    readonly admission: ControlChannelAdmission;
    readonly channel: Channel;
}

export interface ControlChannelServerOptions {
    listeners: readonly ControlChannelListener[];
    routes: ControlChannelRouteProvider;
}

export class ControlChannelServer {
    #listeners: ControlChannelListener[];
    readonly #routes: ControlChannelRouteProvider;
    readonly #connections = new Map<string, PrefixRoute>();
    readonly #startedListeners: ControlChannelListener[] = [];
    #closePromise?: Promise<void>;
    #startPromise?: Promise<void>;
    #started = false;
    #stopping = false;

    constructor(options: ControlChannelServerOptions) {
        if (options.listeners.length === 0) {
            throw new Error(
                "Control channel server requires at least one listener.",
            );
        }
        this.#listeners = [...options.listeners];
        this.#routes = options.routes;
    }

    async start(): Promise<void> {
        if (this.#startPromise !== undefined) {
            return await this.#startPromise;
        }
        const start = this.#startAfterClose();
        this.#startPromise = start;
        try {
            await start;
        } finally {
            if (this.#startPromise === start) {
                this.#startPromise = undefined;
            }
        }
    }

    async #startAfterClose(): Promise<void> {
        const close = this.#closePromise;
        if (close !== undefined) {
            await close;
        }
        if (this.#started) {
            return;
        }
        if (this.#startedListeners.length > 0) {
            await this.#closeListeners();
        }
        await this.#startInternal();
    }

    async close(): Promise<void> {
        this.#stopping = true;
        if (this.#closePromise !== undefined) {
            return await this.#closePromise;
        }
        const close = this.#closeAfterStart();
        this.#closePromise = close;
        try {
            await close;
        } finally {
            if (this.#closePromise === close) {
                this.#closePromise = undefined;
            }
        }
    }

    async replaceListener(
        previous: ControlChannelListener,
        next: ControlChannelListener,
    ): Promise<void> {
        if (!this.#started) {
            throw new Error("Control channel server is not started.");
        }
        const index = this.#listeners.indexOf(previous);
        if (index < 0 || !this.#startedListeners.includes(previous)) {
            throw new Error("Control channel listener is not active.");
        }

        const accept = (connection: ControlAcceptedChannel) =>
            this.#accept(connection);
        await next.start(accept);
        try {
            await previous.close();
        } catch (error) {
            const rollbackFailures: unknown[] = [];
            await next.close().catch((rollbackError) => {
                rollbackFailures.push(rollbackError);
                if (!this.#startedListeners.includes(next)) {
                    this.#startedListeners.push(next);
                }
            });
            await previous.start(accept).catch((rollbackError) => {
                rollbackFailures.push(rollbackError);
            });
            if (rollbackFailures.length > 0) {
                throw new AggregateError(
                    [error, ...rollbackFailures],
                    "Control channel listener replacement failed and rollback was incomplete.",
                );
            }
            throw error;
        }
        this.#listeners[index] = next;
        const startedIndex = this.#startedListeners.indexOf(previous);
        this.#startedListeners[startedIndex] = next;
    }

    async #startInternal(): Promise<void> {
        this.#stopping = false;
        try {
            for (const listener of this.#listeners) {
                await listener.start((connection) => this.#accept(connection));
                this.#startedListeners.push(listener);
            }
            this.#started = true;
        } catch (error) {
            this.#stopping = true;
            this.#closeConnections();
            try {
                await this.#closeListeners();
            } catch (closeError) {
                throw new AggregateError(
                    [error, closeError],
                    "Control channel server failed to start and clean up.",
                );
            }
            throw error;
        }
    }

    async #closeAfterStart(): Promise<void> {
        await this.#startPromise?.catch(() => undefined);
        await this.#closeInternal();
    }

    #accept(connection: ControlAcceptedChannel): void {
        const { admission, channel } = connection;
        if (this.#stopping) {
            channel.close(new Error("Control channel server is stopping."));
            return;
        }
        try {
            let negotiated:
                | { peer: ControlClientKind; protocolVersion: string }
                | undefined;
            let pending:
                | {
                      peer: ControlClientKind;
                      protocolVersion: string;
                      requestId: string;
                  }
                | undefined;
            const route = new PrefixRoute(
                new Codec(channel, { local: "server" }),
                {
                    authorizeRequest: (incoming) => {
                        if (negotiated === undefined) {
                            assertHelloRequest(incoming);
                            if (pending !== undefined) {
                                throw createError({
                                    code: errorCodes.controlClientIdentityInvalid,
                                    message:
                                        "Control connection identity negotiation is already in progress.",
                                    retryable: false,
                                });
                            }
                            const peer = readClientPeer(incoming.peer);
                            if (!admission.allowedPeers.includes(peer)) {
                                throw createError({
                                    code: errorCodes.controlClientIdentityInvalid,
                                    details: {
                                        allowedPeers: [
                                            ...admission.allowedPeers,
                                        ],
                                        requestedPeer: peer,
                                        subject: admission.subject.id,
                                    },
                                    message: `Control transport subject ${admission.subject.id} cannot connect as ${peer}.`,
                                    retryable: false,
                                });
                            }
                            const hello = negotiateControlProtocol(
                                incoming.event.payload,
                                peer,
                            );
                            pending = {
                                peer,
                                protocolVersion: CONTROL_PROTOCOL_VERSION,
                                requestId: incoming.event.id,
                            };
                            return;
                        }
                        if (isHelloRequest(incoming)) {
                            throw createError({
                                code: errorCodes.controlClientIdentityInvalid,
                                message:
                                    "Control connection identity is already negotiated.",
                                retryable: false,
                            });
                        }
                        if (incoming.peer !== negotiated.peer) {
                            throw createError({
                                code: errorCodes.controlClientIdentityInvalid,
                                message: `Control connection is negotiated as ${negotiated.peer}, not ${incoming.peer}.`,
                                retryable: false,
                            });
                        }
                    },
                    eventIdPrefix: "server",
                    getConnectionContext: () => ({
                        protocolVersion:
                            negotiated?.protocolVersion ??
                            pending?.protocolVersion,
                        subject: admission.subject,
                    }),
                    getSnapshot: () => this.#routes.snapshot(),
                    onRequestResult: (incoming, result) => {
                        if (pending?.requestId !== incoming.event.id) return;
                        if (result.ok) {
                            negotiated = {
                                peer: pending.peer,
                                protocolVersion: pending.protocolVersion,
                            };
                        }
                        pending = undefined;
                    },
                },
            );
            this.#connections.set(route.connectionId, route);
            channel.onClose(() => {
                this.#connections.delete(route.connectionId);
                this.#routes.connectionClosed(route.connectionId);
            });
        } catch (error) {
            channel.close(
                error instanceof Error ? error : new Error(String(error)),
            );
        }
    }

    async #closeInternal(): Promise<void> {
        this.#stopping = true;
        this.#closeConnections();
        try {
            await this.#closeListeners();
        } finally {
            this.#started = false;
        }
    }

    #closeConnections(): void {
        for (const route of this.#connections.values()) {
            route.close();
        }
        this.#connections.clear();
    }

    async #closeListeners(): Promise<void> {
        const failures: unknown[] = [];
        const listeners = this.#startedListeners.splice(0);
        const failed = new Set<ControlChannelListener>();
        for (const listener of [...listeners].reverse()) {
            await listener.close().catch((error) => {
                failed.add(listener);
                failures.push(error);
            });
        }
        for (const listener of listeners) {
            if (failed.has(listener)) {
                this.#startedListeners.push(listener);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Control channel listeners failed to close.",
            );
        }
    }
}

function assertHelloRequest(incoming: PrefixRouteIncoming): void {
    if (isHelloRequest(incoming)) return;
    throw createError({
        code: errorCodes.controlClientIdentityRequired,
        details: {
            destination: incoming.destination,
            module: incoming.module,
            operation: incoming.event.name,
        },
        message:
            "service.hello must be the first request on a Control connection.",
        retryable: false,
    });
}

function isHelloRequest(incoming: PrefixRouteIncoming): boolean {
    return (
        incoming.destination === "@control" &&
        incoming.module === "service" &&
        incoming.event.name === "hello" &&
        incoming.event.streamId === undefined
    );
}

function readClientPeer(peer: PrefixRouteIncoming["peer"]): ControlClientKind {
    if (peer === "cli" || peer === "tui" || peer === "web") return peer;
    throw createError({
        code: errorCodes.controlClientIdentityInvalid,
        message: "Server peer cannot initiate a Control client connection.",
        retryable: false,
    });
}

export interface ServiceRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceRouteModule(
    options: ServiceRouteModuleOptions,
): PrefixRouteModuleDefinition {
    return routeModule("service", {
        hello: (request, context) =>
            negotiateControlProtocol(
                request.payload,
                context.peer,
            ) as unknown as JsonValue,
        ping: () => ({ pong: true }),
        status: () => ({
            instanceCount: options.instanceCount(),
            ok: true,
            pid: process.pid,
        }),
        shutdown: (_request, context) => {
            context.afterReply(options.shutdown);
            return { accepted: true };
        },
        restart: (_request, context) => {
            if (options.restart !== undefined) {
                context.afterReply(options.restart);
            }
            return { accepted: true };
        },
    });
}

export function negotiateControlProtocol(
    payload: JsonValue | undefined,
    peer: ControlClientKind,
): ControlProtocolHelloResponse {
    const request = readHelloRequest(payload);
    if (request.clientKind !== peer) {
        throw createError({
            code: errorCodes.controlClientIdentityInvalid,
            message: `service.hello clientKind ${request.clientKind} does not match ${peer}.`,
            retryable: false,
        });
    }
    if (
        compareProtocolVersion(request.protocolRange.min, CONTROL_PROTOCOL_VERSION) > 0 ||
        compareProtocolVersion(request.protocolRange.max, CONTROL_PROTOCOL_VERSION) < 0
    ) {
        throw createError({
            code: errorCodes.protocolVersionUnsupported,
            details: {
                clientMaxProtocolVersion: request.protocolRange.max,
                clientMinProtocolVersion: request.protocolRange.min,
                serverProtocolVersion: CONTROL_PROTOCOL_VERSION,
            },
            message: "Control RPC protocol version is not supported.",
            retryable: false,
        });
    }
    return {
        capabilities: ["request", "stream", "streamResume"],
        protocolVersion: request.legacy
            ? CONTROL_PROTOCOL_LEGACY_VERSION
            : CONTROL_PROTOCOL_VERSION,
    };
}

interface ParsedControlHelloRequest {
    clientKind: ControlClientKind;
    clientVersion?: string;
    legacy: boolean;
    protocolRange: {
        max: string;
        min: string;
    };
}

function readHelloRequest(
    payload: JsonValue | undefined,
): ParsedControlHelloRequest {
    if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload)
    ) {
        throw invalidHello("service.hello requires an object payload.");
    }
    const clientKind = payload.clientKind;
    if (clientKind !== "cli" && clientKind !== "tui" && clientKind !== "web") {
        throw invalidHello(
            "service.hello clientKind must be cli, tui, or web.",
        );
    }
    if (
        payload.clientVersion !== undefined &&
        typeof payload.clientVersion !== "string"
    ) {
        throw invalidHello("service.hello clientVersion must be a string.");
    }
    const base: {
        clientKind: ControlClientKind;
        clientVersion?: string;
    } = {
        clientKind,
        ...(payload.clientVersion === undefined
            ? {}
            : { clientVersion: payload.clientVersion }),
    };
    if (payload.protocolRange !== undefined) {
        if (
            payload.minProtocolVersion !== undefined ||
            payload.maxProtocolVersion !== undefined
        ) {
            throw invalidHello(
                "service.hello must not mix protocolRange with legacy protocol version fields.",
            );
        }
        const protocolRange = readProtocolRange(payload.protocolRange);
        return { ...base, legacy: false, protocolRange };
    }

    const minProtocolVersion = payload.minProtocolVersion;
    const maxProtocolVersion = payload.maxProtocolVersion;
    if (
        !isLegacyProtocolVersion(minProtocolVersion) ||
        !isLegacyProtocolVersion(maxProtocolVersion)
    ) {
        throw invalidHello(
            "service.hello requires protocolRange with semantic versions.",
        );
    }
    if (minProtocolVersion > maxProtocolVersion) {
        throw invalidHello(
            "service.hello minProtocolVersion must not exceed maxProtocolVersion.",
        );
    }
    return {
        ...base,
        legacy: true,
        protocolRange: {
            max: `${maxProtocolVersion}.0.0`,
            min: `${minProtocolVersion}.0.0`,
        },
    };
}

function readProtocolRange(value: JsonValue): { max: string; min: string } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw invalidHello("service.hello protocolRange must be an object.");
    }
    const min = value.min;
    const max = value.max;
    if (typeof min !== "string" || typeof max !== "string") {
        throw invalidHello(
            "service.hello protocolRange min and max must be semantic versions.",
        );
    }
    parseProtocolVersion(min);
    parseProtocolVersion(max);
    if (compareProtocolVersion(min, max) > 0) {
        throw invalidHello(
            "service.hello protocolRange min must not exceed max.",
        );
    }
    return { max, min };
}

function isLegacyProtocolVersion(value: JsonValue | undefined): value is number {
    return (
        typeof value === "number" && Number.isSafeInteger(value) && value > 0
    );
}

function compareProtocolVersion(left: string, right: string): number {
    const leftVersion = parseProtocolVersion(left);
    const rightVersion = parseProtocolVersion(right);
    if (leftVersion.major !== rightVersion.major)
        return leftVersion.major - rightVersion.major;
    if (leftVersion.minor !== rightVersion.minor)
        return leftVersion.minor - rightVersion.minor;
    return leftVersion.patch - rightVersion.patch;
}

function parseProtocolVersion(value: string): {
    major: number;
    minor: number;
    patch: number;
} {
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.exec(value);
    if (match === null) {
        throw invalidHello(`Invalid Control protocol version ${value}.`);
    }
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) {
        throw invalidHello(`Invalid Control protocol version ${value}.`);
    }
    return { major, minor, patch };
}

function invalidHello(message: string): Error {
    return createError({
        code: errorCodes.targetInvalid,
        message,
        retryable: false,
    });
}

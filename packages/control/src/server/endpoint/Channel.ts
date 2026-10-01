import {
    CONTROL_PROTOCOL_LEGACY_VERSION,
    CONTROL_PROTOCOL_VERSION,
    Endpoint,
    Rpc,
    Stream,
    createError,
    errorCodes,
    type Channel,
    type ControlClientKind,
    type ControlHostDefinition,
    type ControlPeerSubject,
    type ControlPortContext,
    type ControlPortDefinition,
    type ControlProtocolHelloResponse,
    type JsonValue,
    type MessageStream,
    type Port,
    type RpcContext,
} from "@portable-devshell/shared";
import { routeModule } from "../Route.js";

export interface ControlChannelRouteProvider {
    connectionClosed(connectionId: string): void;
    hosts(): readonly ControlHostDefinition[];
    onChange(listener: () => void): () => void;
}

export interface ControlChannelListener {
    start(accept: (connection: ControlAcceptedChannel) => void): Promise<void>;
    close(): Promise<void>;
}

export interface ControlChannelAdmission {
    readonly allowedPeers: readonly ControlClientKind[];
    readonly subject: ControlPeerSubject;
}

export interface ControlAcceptedChannel {
    readonly admission: ControlChannelAdmission;
    readonly channel: Channel;
}

export interface ControlChannelServerOptions {
    listeners: readonly ControlChannelListener[];
    routes: ControlChannelRouteProvider;
}

interface Session {
    readonly admission: ControlChannelAdmission;
    peer?: ControlClientKind;
    protocolVersion?: string;
}

interface BoundPort {
    readonly port: Port;
    readonly rpc: Rpc;
    readonly stream: Stream;
    readonly offOpen: () => void;
}

interface ActiveConnection {
    readonly channel: Channel;
    detach?: () => void;
}

export class ControlChannelServer {
    readonly #endpoint = new Endpoint({ host: "server" });
    readonly #ports = new Map<string, BoundPort>();
    readonly #sessions = new Map<string, Session>();
    readonly #connections = new Set<ActiveConnection>();
    readonly #routes: ControlChannelRouteProvider;
    readonly #unsubscribeRoutes: () => void;
    #listeners: ControlChannelListener[];
    readonly #startedListeners: ControlChannelListener[] = [];
    #started = false;

    constructor(options: ControlChannelServerOptions) {
        this.#listeners = [...options.listeners];
        this.#routes = options.routes;
        this.#syncPorts();
        this.#unsubscribeRoutes = options.routes.onChange(() => this.#syncPorts());
    }

    async start(): Promise<void> {
        if (this.#started) return;
        for (const listener of this.#listeners) {
            await listener.start((connection) => void this.#accept(connection));
            this.#startedListeners.push(listener);
        }
        this.#started = true;
    }

    async close(): Promise<void> {
        if (!this.#started) return;
        for (const connection of this.#connections) {
            connection.detach?.();
            connection.channel.close();
        }
        this.#connections.clear();
        for (const listener of [...this.#startedListeners].reverse())
            await listener.close();
        this.#startedListeners.length = 0;
        this.#started = false;
    }

    async replaceListener(
        previous: ControlChannelListener,
        next: ControlChannelListener,
    ): Promise<void> {
        const index = this.#listeners.indexOf(previous);
        await next.start((connection) => void this.#accept(connection));
        await previous.close();
        this.#listeners[index] = next;
        this.#startedListeners[this.#startedListeners.indexOf(previous)] = next;
    }

    async #accept({ admission, channel }: ControlAcceptedChannel): Promise<void> {
        const active: ActiveConnection = { channel };
        this.#connections.add(active);
        try {
            active.detach = await this.#endpoint.accept(channel, {
                attached: (host) => this.#sessions.set(host, { admission }),
                detached: (host) => {
                    this.#sessions.delete(host);
                    this.#routes.connectionClosed(host);
                },
            });
        } catch (error) {
            this.#connections.delete(active);
            channel.close(error instanceof Error ? error : new Error(String(error)));
            return;
        }
        channel.onClose(() => this.#connections.delete(active));
    }

    #syncPorts(): void {
        const definitions = new Map<string, { host: string; port: ControlPortDefinition }>();
        for (const host of this.#routes.hosts())
            for (const port of host.ports)
                definitions.set(`${host.host}\u0000${port.name}`, {
                    host: host.host,
                    port,
                });

        for (const [key, bound] of this.#ports)
            if (!definitions.has(key)) {
                bound.offOpen();
                bound.stream.close();
                bound.rpc.close();
                bound.port.close();
                this.#ports.delete(key);
            }

        for (const [key, definition] of definitions) {
            if (this.#ports.has(key)) continue;
            const port = this.#endpoint.bind(definition.port.name, definition.host);
            const handlers = Object.fromEntries(
                definition.port.operations.map((operation) => [
                    operation.name,
                    async (payload: unknown, rpc: RpcContext) => {
                        const context = this.#context(
                            definition.host,
                            definition.port.name,
                            operation.name,
                            payload as JsonValue | undefined,
                            rpc,
                        );
                        return await operation.handle(
                            {
                                id: rpc.requestId,
                                name: operation.name,
                                ...(payload === undefined
                                    ? {}
                                    : { payload: payload as JsonValue }),
                            },
                            context,
                        );
                    },
                ]),
            );
            const rpc = new Rpc(port, handlers);
            const stream = new Stream(port);
            const streamHandlers = new Map(
                (definition.port.streams ?? []).map((operation) => [
                    operation.name,
                    operation.handle,
                ]),
            );
            const offOpen = stream.onOpen(
                async (messageStream, name, payload, peer) => {
                    const handle = streamHandlers.get(name);
                    if (handle === undefined) {
                        await messageStream.cancel({
                            code: "method_not_found",
                            message: `Stream method ${name} was not found.`,
                        });
                        return;
                    }
                    const controller = new AbortController();
                    messageStream.onClose(() => controller.abort());
                    messageStream.onCancel(() => controller.abort());
                    const context = this.#streamContext(
                        definition.host,
                        peer.host,
                        messageStream,
                        controller.signal,
                    );
                    try {
                        await handle(
                            messageStream,
                            {
                                id: messageStream.id,
                                name,
                                ...(payload === undefined
                                    ? {}
                                    : { payload: payload as JsonValue }),
                            },
                            context,
                        );
                    } catch (error) {
                        await messageStream.cancel({
                            message:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        });
                    }
                },
            );
            this.#ports.set(key, { port, rpc, stream, offOpen });
        }
    }

    #context(
        host: string,
        port: string,
        operation: string,
        payload: JsonValue | undefined,
        rpc: RpcContext,
    ): ControlPortContext {
        const session = this.#sessions.get(rpc.peer.host)!;
        if (host === "@control" && port === "service" && operation === "hello") {
            if (session.peer !== undefined)
                throw createError({
                    code: errorCodes.controlClientIdentityInvalid,
                    message: "Control connection identity is already negotiated.",
                    retryable: false,
                });
            const request = readHelloRequest(payload);
            if (!session.admission.allowedPeers.includes(request.clientKind))
                throw createError({
                    code: errorCodes.controlClientIdentityInvalid,
                    message: `Control transport subject ${session.admission.subject.id} cannot connect as ${request.clientKind}.`,
                    retryable: false,
                });
            const negotiated = negotiateControlProtocol(payload, request.clientKind);
            session.peer = request.clientKind;
            session.protocolVersion = String(negotiated.protocolVersion);
        } else if (session.peer === undefined) {
            throw createError({
                code: errorCodes.controlClientIdentityRequired,
                message: "service.hello must be the first request on a Control connection.",
                retryable: false,
            });
        }
        return {
            afterReply: rpc.afterReply,
            connectionId: rpc.peer.host,
            host,
            peer: session.peer!,
            ...(session.protocolVersion === undefined
                ? {}
                : { protocolVersion: session.protocolVersion }),
            requestId: rpc.requestId,
            signal: rpc.signal,
            subject: session.admission.subject,
        };
    }

    #streamContext(
        host: string,
        peerHost: string,
        stream: MessageStream,
        signal: AbortSignal,
    ): ControlPortContext {
        const session = this.#sessions.get(peerHost)!;
        if (session.peer === undefined)
            throw createError({
                code: errorCodes.controlClientIdentityRequired,
                message: "service.hello must be the first request on a Control connection.",
                retryable: false,
            });
        return {
            afterReply: (action) => queueMicrotask(() => void action()),
            connectionId: peerHost,
            host,
            peer: session.peer,
            ...(session.protocolVersion === undefined
                ? {}
                : { protocolVersion: session.protocolVersion }),
            requestId: stream.id,
            signal,
            subject: session.admission.subject,
        };
    }
}

export interface ServiceRouteModuleOptions {
    instanceCount(): number;
    restart?: () => Promise<void> | void;
    shutdown(): Promise<void> | void;
}

export function createServiceRouteModule(
    options: ServiceRouteModuleOptions,
): ControlPortDefinition {
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

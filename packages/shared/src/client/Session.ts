// Control server session. Owns only the control-plane connection and server
// handshake lifecycle for one shared Endpoint: connect/hello/status, protocol
// version verification, connection state publication, transport-open
// re-handshake, explicit reconnect, and the restart action. It carries no
// domain projections and no transport bundle.

import type { Endpoint } from "../transport/endpoint/Endpoint.js";
import type { JsonValue } from "../types/Json.js";
import {
    CONTROL_PROTOCOL_RANGE,
    type ControlProtocolCapability,
    type ControlServerStatus,
} from "../control/server/Model.js";
import type { ServerTransport } from "../control/server/Transport.js";

const protocolVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

export type ServerSessionStatus = "connecting" | "online" | "offline";

export interface ServerSessionSnapshot {
    readonly capabilities: readonly ControlProtocolCapability[];
    readonly failure?: Error;
    readonly protocolVersion?: string;
    readonly server?: ControlServerStatus;
    readonly status: ServerSessionStatus;
}

interface ParsedProtocolVersion {
    readonly major: number;
    readonly minor: number;
    readonly patch: number;
}

export class ServerSession {
    readonly #endpoint: Endpoint;
    readonly #listeners = new Set<() => void>();
    readonly #offTransportClose: () => void;
    readonly #offTransportOpen: () => void;
    readonly #transport: ServerTransport;
    #closed = false;
    #generation = 0;
    #handshake?: Promise<void>;
    #published: ServerSessionSnapshot = emptySnapshot();
    #reconnect?: Promise<void>;
    #state: ServerSessionSnapshot = emptySnapshot();
    #suppressTransportOpen = false;

    constructor(endpoint: Endpoint, transport: ServerTransport) {
        this.#endpoint = endpoint;
        this.#transport = transport;
        this.#offTransportClose = endpoint.onTransportClose((error) =>
            this.#onTransportClose(error),
        );
        this.#offTransportOpen = endpoint.onTransportOpen(() =>
            this.#onTransportOpen(),
        );
    }

    get state(): Readonly<ServerSessionSnapshot> {
        return this.#published;
    }

    getSnapshot(): Readonly<ServerSessionSnapshot> {
        return this.#published;
    }

    subscribe(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
    }

    /** Performs the connect/hello/status handshake. */
    connect(): Promise<void> {
        if (this.#closed) return Promise.reject(closedError());
        return this.#handshakeOnce();
    }

    /**
     * Reconnects the shared endpoint and re-runs the handshake. The transport
     * open event is suppressed during the explicit reconnect so only one
     * handshake is started.
     */
    reconnect(): Promise<void> {
        if (this.#closed) return Promise.reject(closedError());
        if (this.#reconnect !== undefined) return this.#reconnect;
        const pending = this.#runReconnect().finally(() => {
            if (this.#reconnect === pending) this.#reconnect = undefined;
        });
        this.#reconnect = pending;
        return pending;
    }

    /** Delegates the server restart without refreshing any other domain. */
    async restart(): Promise<Record<string, JsonValue>> {
        if (this.#closed) throw closedError();
        return await this.#transport.restart();
    }

    close(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#generation += 1;
        this.#handshake = undefined;
        this.#offTransportClose();
        this.#offTransportOpen();
        this.#endpoint.close();
        this.#listeners.clear();
        this.#state = emptySnapshot();
        this.#published = this.#state;
    }

    async #runReconnect(): Promise<void> {
        this.#suppressTransportOpen = true;
        try {
            await this.#endpoint.reconnect();
        } catch (error) {
            if (!this.#closed) {
                this.#state = {
                    capabilities: [],
                    failure: toError(error),
                    status: "offline",
                };
                this.#emit();
            }
            throw error;
        } finally {
            this.#suppressTransportOpen = false;
        }
        if (this.#closed) throw closedError();
        await this.#handshakeOnce();
    }

    #onTransportOpen(): void {
        if (this.#closed || this.#suppressTransportOpen) return;
        void this.#handshakeOnce().catch(() => undefined);
    }

    #onTransportClose(error?: Error): void {
        if (this.#closed) return;
        this.#generation += 1;
        this.#handshake = undefined;
        this.#state = {
            capabilities: [],
            ...(error === undefined ? {} : { failure: error }),
            status: "offline",
        };
        this.#emit();
    }

    #handshakeOnce(): Promise<void> {
        const existing = this.#handshake;
        if (existing !== undefined) return existing;
        const generation = ++this.#generation;
        const pending = this.#runHandshake(generation).finally(() => {
            if (this.#handshake === pending) this.#handshake = undefined;
        });
        this.#handshake = pending;
        return pending;
    }

    async #runHandshake(generation: number): Promise<void> {
        this.#state = {
            ...this.#state,
            capabilities: [],
            failure: undefined,
            status: "connecting",
        };
        this.#emit();
        try {
            const hello = await this.#transport.hello();
            if (!isProtocolVersionSupported(hello.protocolVersion)) {
                throw protocolVersionError(hello.protocolVersion);
            }
            const server = await this.#transport.status();
            if (generation !== this.#generation || this.#closed) return;
            this.#state = {
                capabilities: [...hello.capabilities],
                protocolVersion: hello.protocolVersion,
                server,
                status: "online",
            };
            this.#emit();
        } catch (error) {
            if (generation !== this.#generation || this.#closed) throw error;
            this.#state = {
                capabilities: [],
                failure: toError(error),
                status: "offline",
            };
            this.#emit();
            throw error;
        }
    }

    #emit(): void {
        this.#published = this.#state;
        this.#state = { ...this.#state };
        for (const listener of this.#listeners) listener();
    }
}

function emptySnapshot(): ServerSessionSnapshot {
    return { capabilities: [], status: "offline" };
}

function closedError(): Error {
    return new Error("Server session is closed.");
}

function protocolVersionError(version: string): Error {
    return Object.assign(
        new Error(`Incompatible control protocol version: ${version}.`),
        { code: "control.protocolVersionMismatch", retryable: false },
    );
}

function isProtocolVersionSupported(version: string): boolean {
    const parsed = parseProtocolVersion(version);
    const min = parseProtocolVersion(CONTROL_PROTOCOL_RANGE.min);
    const max = parseProtocolVersion(CONTROL_PROTOCOL_RANGE.max);
    if (parsed === undefined || min === undefined || max === undefined)
        return false;
    return (
        compareProtocolVersion(parsed, min) >= 0 &&
        compareProtocolVersion(parsed, max) <= 0
    );
}

function parseProtocolVersion(
    value: string,
): ParsedProtocolVersion | undefined {
    const match = protocolVersionPattern.exec(value);
    if (match === null) return undefined;
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
    return { major, minor, patch };
}

function compareProtocolVersion(
    left: ParsedProtocolVersion,
    right: ParsedProtocolVersion,
): number {
    if (left.major !== right.major) return left.major - right.major;
    if (left.minor !== right.minor) return left.minor - right.minor;
    return left.patch - right.patch;
}

function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
}

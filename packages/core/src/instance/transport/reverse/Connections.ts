import {
    createRemoteError,
    type Channel,
    type JsonValue,
    ReverseSseChannel,
    type ReverseTransport,
    type ReverseUpstreamBatch,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { Instance } from "../../model/Instance.js";

export interface ReverseConnectionIdentity {
    readonly descriptor: Instance;
    readonly generation: number;
}

export interface ReverseConnectionsOptions {
    readonly instances: {
        get(instanceName: string): Instance | undefined;
    };
}

interface ActiveReverseConnection {
    channel: Channel;
    closed: boolean;
    generation: number;
    transport: ReverseTransport;
}

const REVERSE_ACTIVATION_TIMEOUT_MS = 20_000;

interface ReverseGenerationLease {
    readonly descriptor: Instance;
    release(): void;
}

export class ReverseConnections {
    readonly #instances: ReverseConnectionsOptions["instances"];
    readonly #active = new Map<string, ActiveReverseConnection>();
    // A verifying SSE candidate must receive its own upstream RPC responses
    // without prematurely replacing the previously active generation.
    readonly #candidates = new Map<string, ActiveReverseConnection>();
    readonly #activationQueues = new Map<string, Promise<unknown>>();
    #stopped = false;

    constructor(options: ReverseConnectionsOptions) {
        this.#instances = options.instances;
    }

    async activate(
        identity: ReverseConnectionIdentity,
        transport: ReverseTransport,
        channel: Channel,
        options: { credentialReplacement?: boolean } = {},
    ): Promise<void> {
        let generation: ReverseGenerationLease | undefined;
        try {
            generation = this.#acquireIdentityGeneration(identity);
            await this.#exclusive(identity.descriptor.config.name, async () => {
                this.#assertRunning(channel);
                const connection = this.#requireReverseConnection(
                    identity.descriptor,
                );
                const previous = this.#active.get(identity.descriptor.config.name);
                const active = this.#prepareActivation(
                    identity, transport, channel, options.credentialReplacement === true,
                );
                const controller = new AbortController();
                const timeout = setTimeout(
                    () => controller.abort(new Error(
                        "Reverse candidate handshake timed out; previous connection retained.",
                    )),
                    REVERSE_ACTIVATION_TIMEOUT_MS,
                );
                const onClose = () => controller.abort(
                    new Error("Reverse candidate disconnected during handshake."),
                );
                const offClose = channel.onClose(onClose);
                try {
                    await connection.attach(channel, {
                        credentialReplacement: options.credentialReplacement,
                        generation: identity.generation,
                        transport,
                        signal: controller.signal,
                    });
                } catch (error) {
                    if (this.#active.get(identity.descriptor.config.name) === active) {
                        if (previous !== undefined && !previous.closed)
                            this.#active.set(identity.descriptor.config.name, previous);
                        else this.#active.delete(identity.descriptor.config.name);
                    }
                    throw error;
                } finally {
                    clearTimeout(timeout);
                    offClose();
                    if (this.#candidates.get(identity.descriptor.config.name) === active)
                        this.#candidates.delete(identity.descriptor.config.name);
                }
                // Candidate validation must not replace the active SSE
                // upstream route. Promote only after Endpoint's application
                // handshake and peer cutover acknowledgement have succeeded.
                if (active.closed) throw new Error("Reverse candidate closed before promotion.");
                this.#active.set(identity.descriptor.config.name, active);
                if (previous !== undefined && previous !== active)
                    previous.channel.close();
            });
        } catch (error) {
            channel.close();
            throw error;
        } finally {
            generation?.release();
        }
    }

    acceptUpstream(
        identity: ReverseConnectionIdentity,
        batch: ReverseUpstreamBatch,
    ): JsonValue {
        const generation = this.#acquireIdentityGeneration(identity);
        try {
            if (batch.generation !== identity.generation) {
                throw createRemoteError({
                    code: runtimeErrorCodes.reverseGenerationInvalid,
                    message:
                        "Upstream generation does not match request generation.",
                    retryable: true,
                });
            }

            const name = identity.descriptor.config.name;
            const current = this.#active.get(name);
            const pending = this.#candidates.get(name);
            const active = current?.generation === identity.generation
                ? current
                : pending?.generation === identity.generation ? pending : undefined;
            if (
                active === undefined ||
                active.transport !== "sse" ||
                !(active.channel instanceof ReverseSseChannel)
            ) {
                throw createRemoteError({
                    code: runtimeErrorCodes.reverseConnectionSuperseded,
                    message: "SSE connection is not the active generation.",
                    retryable: true,
                });
            }

            let acceptedThrough = active.channel.acceptedUpstreamSeq;
            for (const frame of batch.frames) {
                acceptedThrough = active.channel.acceptUpstream(
                    frame.seq,
                    frame.frame,
                );
            }
            return {
                acceptedThrough,
                generation: identity.generation,
            };
        } finally {
            generation.release();
        }
    }

    disconnect(instance: string): void {
        const active = this.#active.get(instance);
        const candidate = this.#candidates.get(instance);
        this.#active.delete(instance);
        this.#candidates.delete(instance);
        candidate?.channel.close();
        active?.channel.close();
    }

    stop(): void {
        this.#stopped = true;
        for (const active of this.#active.values()) active.channel.close();
        for (const candidate of this.#candidates.values()) candidate.channel.close();
        this.#active.clear();
        this.#candidates.clear();
    }

    #prepareActivation(
        identity: ReverseConnectionIdentity,
        transport: ReverseTransport,
        channel: Channel,
        credentialReplacement: boolean,
    ): ActiveReverseConnection {
        const name = identity.descriptor.config.name;
        const previous = this.#active.get(name);
        const previousGeneration = previous?.generation ?? 0;
        if (
            !Number.isSafeInteger(identity.generation) ||
            identity.generation <= 0 ||
            (!credentialReplacement && identity.generation <= previousGeneration)
        ) {
            channel.close();
            throw createRemoteError({
                code: runtimeErrorCodes.reverseGenerationInvalid,
                details: {
                    generation: identity.generation,
                    instance: name,
                    previousGeneration,
                },
                message: `Connection generation must be greater than ${previousGeneration}.`,
                retryable: true,
            });
        }

        const active: ActiveReverseConnection = {
            channel,
            closed: false,
            generation: identity.generation,
            transport,
        };
        this.#candidates.set(name, active);
        channel.onClose(() => {
            active.closed = true;
            if (this.#candidates.get(name) === active) this.#candidates.delete(name);
            if (this.#active.get(name) === active) this.#active.delete(name);
        });
        return active;
    }

    #acquireIdentityGeneration(
        identity: ReverseConnectionIdentity,
    ): ReverseGenerationLease {
        const name = identity.descriptor.config.name;
        const instance = this.#instances.get(name);
        if (instance === undefined) throw retiredGeneration(name);
        let lease: { instance: Instance; release(): void };
        try {
            lease = instance.lifecycle.acquireLease();
        } catch {
            throw retiredGeneration(name);
        }
        if (lease.instance === identity.descriptor) {
            return {
                descriptor: identity.descriptor,
                release: () => lease.release(),
            };
        }
        lease.release();
        throw retiredGeneration(name);
    }

    #requireReverseConnection(instance: Instance) {
        const connection = instance.provision.reverseConnection;
        if (instance.config.provider !== "reverse" || connection === undefined) {
            throw createRemoteError({
                code: runtimeErrorCodes.reverseInstanceNotReverse,
                details: { instance: instance.config.name },
                message: `Instance ${instance.config.name} is not configured for reverse connections.`,
                retryable: false,
            });
        }
        return connection;
    }

    async #exclusive<T>(
        instance: string,
        operation: () => Promise<T>,
    ): Promise<T> {
        const previous = this.#activationQueues.get(instance) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        const tracked = next
            .then(
                () => undefined,
                () => undefined,
            )
            .finally(() => {
                if (this.#activationQueues.get(instance) === tracked) {
                    this.#activationQueues.delete(instance);
                }
            });
        this.#activationQueues.set(instance, tracked);
        return await next;
    }

    #assertRunning(channel?: Channel): void {
        if (!this.#stopped) return;
        channel?.close();
        throw createRemoteError({
            code: runtimeErrorCodes.reverseTransportUnavailable,
            message: "Reverse connection service is stopping.",
            retryable: true,
        });
    }
}

function retiredGeneration(instance: string): Error {
    return createRemoteError({
        code: runtimeErrorCodes.instanceConflict,
        details: { instance, operation: "reverse.connect" },
        message: `Instance ${instance} generation was retired during reverse connection admission.`,
        retryable: true,
    });
}

import type { WorkerRpcChannel } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    type JsonValue,
    type ReverseEnrollmentRequest,
    type ReverseUpstreamBatch
} from "@portable-devshell/shared";

import { ReverseCredentialStore } from "./ReverseCredentialStore.js";
import type {
    ReverseInstanceLookupPort,
    ReverseInstancePort
} from "./ReverseInstancePort.js";
import { ReverseRpcSseChannel } from "./rpc/ReverseRpcSseChannel.js";

interface ActiveReverseConnection {
    channel: WorkerRpcChannel;
    generation: number;
    transport: "sse" | "wss";
}

export interface ReverseConnectionIdentity {
    descriptor: ReverseInstancePort;
    generation: number;
}

export interface ReverseConnectionServiceOptions {
    credentialStore: ReverseCredentialStore;
    instanceRegistry: ReverseInstanceLookupPort;
    publicBaseUrl: string;
}

export class ReverseConnectionService {
    readonly #credentialStore: ReverseCredentialStore;
    readonly #instanceRegistry: ReverseInstanceLookupPort;
    readonly #publicBaseUrl: string;
    readonly #active = new Map<string, ActiveReverseConnection>();
    readonly #activationQueues = new Map<string, Promise<unknown>>();

    constructor(options: ReverseConnectionServiceOptions) {
        this.#credentialStore = options.credentialStore;
        this.#instanceRegistry = options.instanceRegistry;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    async enroll(body: ReverseEnrollmentRequest): Promise<JsonValue> {
        const credential = await this.#credentialStore.consumeDeviceCode(body.deviceCode);
        const descriptor = this.#requireReverseInstance(credential.instance);
        await descriptor.worker.setReverseEnrollmentState("enrolled");
        this.disconnect(descriptor.name);
        return {
            controllerUrl: this.#publicBaseUrl,
            deviceToken: credential.deviceToken,
            instance: descriptor.name,
            workspace: descriptor.workspace ?? ""
        };
    }

    async authenticate(
        instance: string,
        generation: number,
        token: string
    ): Promise<ReverseConnectionIdentity> {
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

    async activate(
        identity: ReverseConnectionIdentity,
        transport: "sse" | "wss",
        channel: WorkerRpcChannel
    ): Promise<void> {
        await this.#exclusive(identity.descriptor.name, async () => {
            const previous = this.#active.get(identity.descriptor.name);
            const previousGeneration = Math.max(
                previous?.generation ?? 0,
                identity.descriptor.worker.snapshot().reverse?.generation ?? 0
            );

            if (
                !Number.isSafeInteger(identity.generation) ||
                identity.generation <= previousGeneration
            ) {
                channel.close();
                throw createError({
                    code: errorCodes.reverseGenerationInvalid,
                    details: {
                        generation: identity.generation,
                        instance: identity.descriptor.name,
                        previousGeneration
                    },
                    message: `Connection generation must be greater than ${previousGeneration}.`,
                    retryable: true
                });
            }

            const active: ActiveReverseConnection = {
                channel,
                generation: identity.generation,
                transport
            };
            this.#active.set(identity.descriptor.name, active);
            channel.onDisconnect(() => {
                if (this.#active.get(identity.descriptor.name) === active) {
                    this.#active.delete(identity.descriptor.name);
                }
            });

            try {
                await identity.descriptor.worker.acceptReverseChannel(channel, {
                    generation: identity.generation,
                    transport
                });
            } catch (error) {
                if (this.#active.get(identity.descriptor.name) === active) {
                    this.#active.delete(identity.descriptor.name);
                }
                channel.close();
                throw error;
            }
        });
    }

    acceptUpstream(
        identity: ReverseConnectionIdentity,
        batch: ReverseUpstreamBatch
    ): JsonValue {
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

        return {
            acceptedThrough,
            generation: identity.generation
        };
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
        if (
            descriptor.provider !== "reverse" ||
            descriptor.reverseConnector === undefined
        ) {
            throw createError({
                code: errorCodes.reverseInstanceNotReverse,
                details: { instance },
                message: `Instance ${instance} is not configured for reverse connections.`,
                retryable: false
            });
        }
        return descriptor;
    }

    async #exclusive<T>(
        instance: string,
        operation: () => Promise<T>
    ): Promise<T> {
        const previous = this.#activationQueues.get(instance) ?? Promise.resolve();
        const next = previous.then(operation, operation);
        const tracked = next.then(
            () => undefined,
            () => undefined
        ).finally(() => {
            if (this.#activationQueues.get(instance) === tracked) {
                this.#activationQueues.delete(instance);
            }
        });
        this.#activationQueues.set(instance, tracked);
        return await next;
    }
}

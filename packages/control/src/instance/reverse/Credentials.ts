import {
    createRemoteError,
    controlErrorCodes,
    type ReverseDeviceCodeResult,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { Instance } from "@portable-devshell/core";
import type {
    ReverseEnrollmentCredential,
    ReverseInstanceLookup,
} from "./Api.js";
import { ReverseCredentialStore } from "./credential/Store.js";

export class ReverseCredentials {
    readonly #credentialStore: ReverseCredentialStore;
    readonly #instanceRegistry: ReverseInstanceLookup;
    #publicBaseUrl: string;
    #disconnect?: (instance: string) => void;

    constructor(options: {
        credentialStore: ReverseCredentialStore;
        instanceRegistry: ReverseInstanceLookup;
        publicBaseUrl: string;
    }) {
        this.#credentialStore = options.credentialStore;
        this.#instanceRegistry = options.instanceRegistry;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    setPublicBaseUrl(publicBaseUrl: string): void {
        this.#publicBaseUrl = publicBaseUrl;
    }

    setDisconnectHandler(handler: (instance: string) => void): void {
        this.#disconnect = handler;
    }

    async createDeviceCode(instance: string): Promise<ReverseDeviceCodeResult> {
        this.#requireReverseInstance(instance);
        const result = await this.#credentialStore.createDeviceCode(instance);
        return {
            controllerUrl: this.#publicBaseUrl,
            ...result,
        };
    }

    async consumeDeviceCode(
        deviceCode: string,
    ): Promise<ReverseEnrollmentCredential> {
        const credential = await this.#credentialStore.consumeDeviceCode(deviceCode);
        this.#requireReverseInstance(credential.instance);
        this.#disconnect?.(credential.instance);
        return credential;
    }

    async authenticate(instance: string, deviceToken: string): Promise<Instance> {
        const descriptor = this.#requireReverseInstance(instance);
        if (!(await this.#credentialStore.authenticate(instance, deviceToken))) {
            throw invalidDeviceToken(instance);
        }
        return descriptor;
    }

    async runAuthenticated(
        instance: string,
        deviceToken: string,
        operation: () => Promise<void>,
    ): Promise<void> {
        this.#requireReverseInstance(instance);
        const authenticated = await this.#credentialStore.withAuthenticatedToken(
            instance,
            deviceToken,
            operation,
        );
        if (!authenticated) throw invalidDeviceToken(instance);
    }

    async rotateDeviceToken(
        instance: string,
    ): Promise<{ deviceToken: string; instance: string }> {
        this.#requireReverseInstance(instance);
        const deviceToken = await this.#credentialStore.rotateToken(instance);
        this.#disconnect?.(instance);
        return {
            deviceToken,
            instance,
        };
    }

    async revokeDeviceToken(
        instance: string,
    ): Promise<{ instance: string; revoked: true }> {
        this.#requireReverseInstance(instance);
        await this.#credentialStore.revoke(instance);
        this.#disconnect?.(instance);
        return { instance, revoked: true };
    }

    async retireInstance(instance: string): Promise<void> {
        await this.#credentialStore.retire(instance);
        this.#disconnect?.(instance);
    }

    #requireReverseInstance(instance: string): Instance {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor === undefined) {
            throw createRemoteError({
                code: controlErrorCodes.instanceNotFound,
                details: { instance },
                message: `Instance ${instance} was not found.`,
                retryable: false,
            });
        }
        if (descriptor.config.provider !== "reverse") {
            throw createRemoteError({
                code: runtimeErrorCodes.reverseInstanceNotReverse,
                details: { instance },
                message: `Instance ${instance} is not a reverse instance.`,
                retryable: false,
            });
        }
        return descriptor;
    }
}

function invalidDeviceToken(instance: string): Error {
    return createRemoteError({
        code: runtimeErrorCodes.reverseDeviceTokenInvalid,
        details: { instance },
        message: "Device token is invalid or revoked.",
        retryable: false,
    });
}

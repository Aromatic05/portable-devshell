import {
    createRemoteError,
    controlErrorCodes,
    type ReverseDeviceCodeResult,
    runtimeErrorCodes,
} from "@portable-devshell/shared";

import type { ReverseInstanceLookup } from "../Api.js";
import type { Instance } from "../../model/Instance.js";
import { ReverseCredentialStore } from "./Store.js";

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

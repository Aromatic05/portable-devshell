import { createError, errorCodes, type ReverseDeviceCodeResult } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";
import { ReverseCredentialStore } from "./ReverseCredentialStore.js";

export class ReverseControlService {
    readonly #credentialStore: ReverseCredentialStore;
    readonly #instanceRegistry: InstanceRegistry;
    readonly #publicBaseUrl: string;
    #disconnect?: (instance: string) => void;

    constructor(options: {
        credentialStore: ReverseCredentialStore;
        instanceRegistry: InstanceRegistry;
        publicBaseUrl: string;
    }) {
        this.#credentialStore = options.credentialStore;
        this.#instanceRegistry = options.instanceRegistry;
        this.#publicBaseUrl = options.publicBaseUrl;
    }

    setDisconnectHandler(handler: (instance: string) => void): void {
        this.#disconnect = handler;
    }

    async createDeviceCode(instance: string): Promise<ReverseDeviceCodeResult> {
        const descriptor = this.#requireReverseInstance(instance);
        const result = await this.#credentialStore.createDeviceCode(instance);
        await descriptor.worker.setReverseEnrollmentState("pending");
        return {
            controllerUrl: this.#publicBaseUrl,
            ...result
        };
    }

    async rotateDeviceToken(instance: string): Promise<{ deviceToken: string; instance: string }> {
        this.#requireReverseInstance(instance);
        const deviceToken = await this.#credentialStore.rotateToken(instance);
        this.#disconnect?.(instance);
        return {
            deviceToken,
            instance
        };
    }

    async revokeDeviceToken(instance: string): Promise<{ instance: string; revoked: true }> {
        const descriptor = this.#requireReverseInstance(instance);
        await this.#credentialStore.revoke(instance);
        this.#disconnect?.(instance);
        await descriptor.worker.setReverseEnrollmentState("revoked");
        return { instance, revoked: true };
    }

    #requireReverseInstance(instance: string): InstanceDescriptor {
        const descriptor = this.#instanceRegistry.get(instance);
        if (descriptor === undefined) {
            throw createError({
                code: errorCodes.instanceMissing,
                details: { instance },
                message: `Instance ${instance} was not found.`,
                retryable: false
            });
        }
        if (descriptor.provider !== "reverse") {
            throw createError({
                code: errorCodes.reverseInstanceNotReverse,
                details: { instance },
                message: `Instance ${instance} is not a reverse instance.`,
                retryable: false
            });
        }
        return descriptor;
    }
}

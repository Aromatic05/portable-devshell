import type { ExtensionJsonValue } from "@portable-devshell/extension";

import type { ExtensionPointValidationContext } from "../ExtensionPointRegistry.js";

export interface ExtensionSandboxPointCodec {
    describeBinding(binding: unknown, context: ExtensionPointValidationContext): ExtensionJsonValue;
    readonly id: string;
    invokeBinding(
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> | unknown;
}

/** Worker-local registry for private binding serialization and invocation. */
export class ExtensionSandboxPointCodecRegistry {
    readonly #codecs = new Map<string, ExtensionSandboxPointCodec>();

    constructor(codecs: readonly ExtensionSandboxPointCodec[]) {
        for (const codec of codecs) {
            if (!/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/u.test(codec.id)) {
                throw new TypeError(`Extension sandbox point id is invalid: ${codec.id}.`);
            }
            if (this.#codecs.has(codec.id)) {
                throw new TypeError(`Extension sandbox point codec ${codec.id} is registered more than once.`);
            }
            this.#codecs.set(codec.id, codec);
        }
    }

    describeBinding(
        pointId: string,
        binding: unknown,
        context: ExtensionPointValidationContext
    ): ExtensionJsonValue {
        return this.#require(pointId, context.extensionId).describeBinding(binding, context);
    }

    async invokeBinding(
        pointId: string,
        binding: unknown,
        input: ExtensionJsonValue | undefined,
        signal: AbortSignal,
        context: ExtensionPointValidationContext
    ): Promise<unknown> {
        return await this.#require(pointId, context.extensionId).invokeBinding(binding, input, signal, context);
    }

    #require(pointId: string, extensionId: string): ExtensionSandboxPointCodec {
        const codec = this.#codecs.get(pointId);
        if (codec !== undefined) return codec;
        throw new TypeError(`Extension ${extensionId} cannot sandbox unsupported Extension Point ${pointId}.`);
    }
}

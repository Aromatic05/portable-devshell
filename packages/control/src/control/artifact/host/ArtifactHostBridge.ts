import { join } from "node:path";

import type {
    WorkerArtifactPayloadOpenInput,
    WorkerArtifactReceiveBeginInput
} from "@portable-devshell/core";
import { createError } from "@portable-devshell/shared";

import type { ArtifactServiceEndpoint } from "../ArtifactServiceModel.js";
import { artifactBlake3 } from "./ArtifactHostHash.js";
import { ArtifactHostPayloadStore } from "./ArtifactHostPayloadStore.js";
import { ArtifactHostReceiveStore } from "./ArtifactHostReceiveStore.js";
import type {
    ArtifactHostAccessContext,
    ArtifactHostBridgeOptions
} from "./ArtifactHostModel.js";

export class ArtifactHostBridge {
    readonly #payloads: ArtifactHostPayloadStore;
    readonly #receives: ArtifactHostReceiveStore;

    constructor(options: ArtifactHostBridgeOptions) {
        const processCwd = options.processCwd ?? process.cwd();
        this.#payloads = new ArtifactHostPayloadStore({
            homeDirectory: options.homeDirectory,
            processCwd,
            root: join(options.storageDir, "payloads")
        });
        this.#receives = new ArtifactHostReceiveStore({
            downloadDirectory: join(options.homeDirectory, "Download"),
            root: join(options.storageDir, "receives")
        });
    }

    async initialize(): Promise<void> {
        await this.#payloads.initialize();
        await this.#receives.initialize();
    }

    endpointFor(context: ArtifactHostAccessContext): ArtifactServiceEndpoint {
        return {
            abortArtifactReceive: async (receiveId) => await this.#receives.abort(receiveId),
            appendControlEvent: async (type, data) => await context.appendControlEvent(type, data),
            beginArtifactReceive: async (input: WorkerArtifactReceiveBeginInput) =>
                await this.#receives.begin(input),
            closeArtifactPayload: async (payloadId) => await this.#payloads.close(payloadId),
            finishArtifactReceive: async (receiveId) => await this.#receives.finish(receiveId),
            openArtifactPayload: async (input: WorkerArtifactPayloadOpenInput) => {
                if ("handle" in input && input.handle !== undefined) {
                    throw createError({
                        code: "artifact.hostHandleUnsupported",
                        message: "Artifact handles cannot use the host pseudo-instance.",
                        retryable: false
                    });
                }
                if (!("path" in input) || input.path === undefined) {
                    throw createError({
                        code: "artifact.hostPathDenied",
                        message: "Host source requires a filesystem path.",
                        retryable: false
                    });
                }
                return await this.#payloads.openPath(
                    input.path,
                    input.expiresAtMs,
                    context
                );
            },
            readArtifactPayload: async (input) =>
                await this.#payloads.read(
                    input.payloadId,
                    input.offsetBytes,
                    input.maxBytes
                ),
            writeArtifactReceive: async (input) => await this.#receives.write(input)
        };
    }

    async blake3(bytes: Uint8Array): Promise<string> {
        return await artifactBlake3(bytes);
    }
}

export type { ArtifactHostAccessContext, ArtifactHostBridgeOptions } from "./ArtifactHostModel.js";

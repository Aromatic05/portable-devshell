import { join } from "node:path";

import {
    createRemoteError,
    type WorkerArtifactApi,
} from "@portable-devshell/shared";

import { artifactBlake3 } from "./Hash.js";
import { ArtifactHostPayloadStore } from "./storage/PayloadStore.js";
import { ArtifactHostReceiveStore } from "./storage/ReceiveStore.js";
import type {
    ArtifactHostAccessContext,
    ArtifactHostBridgeOptions,
} from "./Model.js";

export class ArtifactHostBridge {
    readonly #payloads: ArtifactHostPayloadStore;
    readonly #receives: ArtifactHostReceiveStore;

    constructor(options: ArtifactHostBridgeOptions) {
        this.#payloads = new ArtifactHostPayloadStore({
            homeDirectory: options.homeDirectory,
            root: join(options.storageDir, "payloads"),
        });
        this.#receives = new ArtifactHostReceiveStore({
            downloadDirectory: join(options.homeDirectory, "Download"),
            root: join(options.storageDir, "receives"),
        });
    }

    async initialize(): Promise<void> {
        await this.#payloads.initialize();
        await this.#receives.initialize();
    }

    endpointFor(context: ArtifactHostAccessContext): WorkerArtifactApi {
        return {
            abortArtifactReceive: async (receiveId) =>
                await this.#receives.abort(receiveId),
            beginArtifactReceive: async (input) =>
                await this.#receives.begin(input),
            closeArtifactPayload: async (payloadId) =>
                await this.#payloads.close(payloadId),
            finishArtifactReceive: async (receiveId) =>
                await this.#receives.finish(receiveId),
            openArtifactPayload: async (input) => {
                if ("handle" in input && input.handle !== undefined) {
                    throw createRemoteError({
                        code: "artifact.hostHandleUnsupported",
                        message:
                            "Artifact handles cannot use the host pseudo-instance.",
                        retryable: false,
                    });
                }
                if (!("path" in input) || input.path === undefined) {
                    throw createRemoteError({
                        code: "artifact.hostPathDenied",
                        message: "Host source requires a filesystem path.",
                        retryable: false,
                    });
                }
                return await this.#payloads.openPath(
                    input.path,
                    input.expiresAtMs,
                    input.workspace,
                    context,
                );
            },
            readArtifactPayload: async (input) =>
                await this.#payloads.read(
                    input.payloadId,
                    input.offsetBytes,
                    input.maxBytes,
                ),
            writeArtifactReceive: async (input) =>
                await this.#receives.write(input),
        };
    }

    async blake3(bytes: Uint8Array): Promise<string> {
        return await artifactBlake3(bytes);
    }
}

export type {
    ArtifactHostAccessContext,
    ArtifactHostBridgeOptions,
} from "./Model.js";

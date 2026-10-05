import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    createRemoteError,
    controlErrorCodes,
} from "@portable-devshell/shared";
import type {
    ExtensionAssetProjectionInput,
    ExtensionAssetProjectionResult,
} from "@portable-devshell/extension/asset";
import type { ExtensionAssetProjectionPortInput } from "../extension/api/cap/asset/Control.js";

import { ArtifactHttpRoute, artifactShareRoute } from "./route/Http.js";
import { ArtifactHostBridge } from "./host/Bridge.js";
import { ArtifactService } from "./Service.js";
import type { InstanceRegistry } from "@portable-devshell/core/instance";
import type { ControlConfig, ControlPathHome } from "@portable-devshell/shared";

export interface ArtifactModuleOptions {
    config: () => ControlConfig;
    controlPaths: ControlPathHome;
    homeDirectory?: string;
    instances: InstanceRegistry;
}

export class ArtifactModule {
    readonly #config: () => ControlConfig;
    readonly #controlPaths: ControlPathHome;
    readonly #homeDirectory: string;
    readonly #instances: InstanceRegistry;
    readonly #extensionAssetAuthorities = new Set<string>();
    #bridge?: ArtifactHostBridge;
    #service?: ArtifactService;

    constructor(options: ArtifactModuleOptions) {
        this.#config = options.config;
        this.#controlPaths = options.controlPaths;
        this.#homeDirectory = options.homeDirectory ?? homedir();
        this.#instances = options.instances;
    }

    get service(): ArtifactService {
        if (this.#service === undefined)
            throw new Error("Artifact runtime is not started.");
        return this.#service;
    }

    async start(): Promise<void> {
        const bridge = new ArtifactHostBridge({
            homeDirectory: this.#homeDirectory,
            storageDir: join(this.#controlPaths.artifactsDir, "host"),
        });
        this.#bridge = bridge;
        await bridge.initialize();
        const service = new ArtifactService({
            directTransfer: this.#config().control.artifactDirectTransfer,
            resolveEndpoint: (name, authorityInstance) =>
                this.#resolveEndpoint(name, authorityInstance),
            shareUrl: (token) => artifactShareUrl(this.#config(), token),
            storageDir: this.#controlPaths.artifactsDir,
        });
        this.#service = service;
        await service.initialize();
    }

    installHttpRoute(
        server: Parameters<ArtifactHttpRoute["install"]>[0],
    ): void {
        new ArtifactHttpRoute(this.service, {
            publicBaseUrl: this.#config().mcp.publicBaseUrl,
        }).install(server);
    }

    async stop(): Promise<void> {
        await this.#service?.stop();
        this.#service = undefined;
        this.#bridge = undefined;
    }

    async transferExtensionAsset(
        extensionId: string,
        input: {
            overwrite?: boolean;
            signal?: AbortSignal;
            sourcePath: string;
            target: { instance: string; path: string; workspace: string };
        },
    ): Promise<ExtensionAssetProjectionResult> {
        input.signal?.throwIfAborted();
        const authority = `@extension-asset:${randomUUID()}`;
        this.#extensionAssetAuthorities.add(authority);
        try {
            const started = await this.service.startTransfer(
                {
                    instance: "host",
                    operation: "start",
                    ...(input.overwrite === undefined
                        ? {}
                        : { overwrite: input.overwrite }),
                    sourcePath: input.sourcePath,
                    sourceWorkspace: input.sourcePath,
                    targetInstance: input.target.instance,
                    targetPath: input.target.path,
                    targetWorkspace: input.target.workspace,
                },
                authority,
            );
            const transferId = started.transfer.transferId;
            const abort = () => {
                void this.service
                    .cancelTransfer(transferId)
                    .catch(() => undefined);
            };
            input.signal?.addEventListener("abort", abort, { once: true });
            try {
                const completed =
                    await this.service.waitForTransfer(transferId);
                input.signal?.throwIfAborted();
                if (completed.status !== "completed") {
                    throw new Error(
                        completed.failure?.message ??
                            `Extension ${extensionId} asset transfer ${transferId} ended with status ${completed.status}.`,
                    );
                }
                return Object.freeze({
                    transferredBytes: completed.transferredBytes,
                });
            } finally {
                input.signal?.removeEventListener("abort", abort);
            }
        } finally {
            this.#extensionAssetAuthorities.delete(authority);
        }
    }

    async projectExtensionAsset(
        extensionId: string,
        input: ExtensionAssetProjectionPortInput,
    ): Promise<ExtensionAssetProjectionResult> {
        input.signal?.throwIfAborted();
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(input.target.key) || input.target.key === "." || input.target.key === "..")
            throw new TypeError("Extension asset key must be a single logical entry name.");
        const descriptor = this.#instances.get(input.target.instance);
        if (descriptor === undefined)
            throw new Error(`Instance ${input.target.instance} is unavailable.`);
        const lease = descriptor.acquireLease();
        try {
            const prepared = await lease.instance.worker.prepareExtensionResource({
                collection: input.target.collection,
                extensionId,
            });
            return await this.transferExtensionAsset(extensionId, {
                overwrite: input.overwrite,
                signal: input.signal,
                sourcePath: input.sourcePath,
                target: {
                    instance: input.target.instance,
                    path: join(prepared.directory, input.target.key),
                    workspace: prepared.directory,
                },
            });
        } finally { lease.release(); }
    }

    #resolveEndpoint(name: string, authorityInstance?: string) {
        if (name !== "host") return this.#instances.get(name)?.worker;
        if (authorityInstance === undefined || this.#bridge === undefined)
            return undefined;
        if (!this.#extensionAssetAuthorities.has(authorityInstance))
            return undefined;
        return this.#bridge.endpointFor({
            authorityInstance,
            provider: "local",
            securityMode: "disabled",
        });
    }
}

function artifactShareUrl(config: ControlConfig, token: string): string {
    if (!config.mcp.enabled) {
        throw createRemoteError({
            code: controlErrorCodes.configValidationFailed,
            message:
                "Artifact sharing requires the MCP HTTP host to be enabled.",
            retryable: false,
        });
    }
    const localHost = normalizeArtifactHttpHost(config.mcp.listenHost);
    const base = new URL(
        config.mcp.publicBaseUrl ??
            `http://${localHost}:${config.mcp.listenPort}`,
    );
    base.pathname = `${artifactShareRoute(base.toString())}/${encodeURIComponent(token)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
}

function normalizeArtifactHttpHost(host: string): string {
    if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
    createRemoteError,
    controlErrorCodes,
    type ArtifactTargetDescriptor,
    type ArtifactTransferRecord,
} from "@portable-devshell/shared";

import { ArtifactHttpRoute, artifactShareRoute } from "./route/Http.js";
import { ArtifactHostBridge } from "./host/index.js";
import { ArtifactService } from "./Service.js";
import type { InstanceRegistry } from "../instance/Api.js";
import type { ControlConfig, ControlPathHome } from "@portable-devshell/shared";
import type {
    ArtifactRuntime,
    ArtifactRuntimeOptions,
} from "./Api.js";

class ArtifactRuntimeState implements ArtifactRuntime {
    readonly #config: () => ControlConfig;
    readonly #controlPaths: ControlPathHome;
    readonly #homeDirectory: string;
    readonly #instances: InstanceRegistry;
    readonly #hostTransferAuthorities = new Set<string>();
    #bridge?: ArtifactHostBridge;
    #service?: ArtifactService;

    constructor(options: ArtifactRuntimeOptions) {
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
        server: Parameters<ArtifactRuntime["installHttpRoute"]>[0],
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

    async transferHostPath(
        sourcePath: string,
        target: ArtifactTargetDescriptor,
        overwrite?: boolean,
        signal?: AbortSignal,
    ): Promise<ArtifactTransferRecord> {
        signal?.throwIfAborted();
        if (target.workspace === undefined)
            throw new TypeError("Host Artifact transfer target requires a workspace.");
        const authority = `@host-artifact:${randomUUID()}`;
        this.#hostTransferAuthorities.add(authority);
        try {
            const started = await this.service.startTransfer(
                {
                    instance: "host",
                    operation: "start",
                    ...(overwrite === undefined
                        ? {}
                        : { overwrite }),
                    sourcePath,
                    sourceWorkspace: sourcePath,
                    targetInstance: target.instance,
                    targetPath: target.path,
                    targetWorkspace: target.workspace,
                },
                authority,
            );
            const transferId = started.transfer.transferId;
            const abort = () => {
                void this.service
                    .cancelTransfer(transferId)
                    .catch(() => undefined);
            };
            signal?.addEventListener("abort", abort, { once: true });
            try {
                const completed =
                    await this.service.waitForTransfer(transferId);
                signal?.throwIfAborted();
                if (completed.status !== "completed") {
                    throw new Error(
                        completed.failure?.message ??
                            `Host Artifact transfer ${transferId} ended with status ${completed.status}.`,
                    );
                }
                return completed;
            } finally {
                signal?.removeEventListener("abort", abort);
            }
        } finally {
            this.#hostTransferAuthorities.delete(authority);
        }
    }

    #resolveEndpoint(name: string, authorityInstance?: string) {
        if (name !== "host") return this.#instances.get(name)?.worker.execution.artifact;
        if (authorityInstance === undefined || this.#bridge === undefined)
            return undefined;
        if (!this.#hostTransferAuthorities.has(authorityInstance))
            return undefined;
        return this.#bridge.endpointFor({
            authorityInstance,
            provider: "local",
            securityMode: "disabled",
        });
    }
}

export function createArtifactRuntime(
    options: ArtifactRuntimeOptions,
): ArtifactRuntime {
    return new ArtifactRuntimeState(options);
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

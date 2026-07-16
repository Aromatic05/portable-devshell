import { homedir } from "node:os";
import { join } from "node:path";

import { createError, errorCodes } from "@portable-devshell/shared";

import { ArtifactHttpRoute, artifactShareRoute } from "../../control/artifact/route/ArtifactHttpRoute.js";
import { ArtifactHostBridge } from "../../control/artifact/host/ArtifactHostBridge.js";
import { ArtifactService } from "../../control/artifact/ArtifactService.js";
import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";
import type { ControlConfig, ControlPathHome } from "@portable-devshell/shared";

export interface ControlRuntimeArtifactOptions {
    config: () => ControlConfig;
    controlPaths: ControlPathHome;
    homeDirectory?: string;
    instances: InstanceRegistry;
}

export class ControlRuntimeArtifact {
    readonly #config: () => ControlConfig;
    readonly #controlPaths: ControlPathHome;
    readonly #homeDirectory: string;
    readonly #instances: InstanceRegistry;
    #bridge?: ArtifactHostBridge;
    #service?: ArtifactService;

    constructor(options: ControlRuntimeArtifactOptions) {
        this.#config = options.config;
        this.#controlPaths = options.controlPaths;
        this.#homeDirectory = options.homeDirectory ?? homedir();
        this.#instances = options.instances;
    }

    get service(): ArtifactService {
        if (this.#service === undefined) throw new Error("Artifact runtime is not started.");
        return this.#service;
    }

    async start(): Promise<void> {
        const bridge = new ArtifactHostBridge({
            homeDirectory: this.#homeDirectory,
            storageDir: join(this.#controlPaths.artifactsDir, "host")
        });
        await bridge.initialize();
        this.#bridge = bridge;
        const service = new ArtifactService({
            resolveEndpoint: (name, authorityInstance) => this.#resolveEndpoint(name, authorityInstance),
            shareUrl: (token) => artifactShareUrl(this.#config(), token),
            storageDir: this.#controlPaths.artifactsDir
        });
        await service.initialize();
        this.#service = service;
    }

    installHttpRoute(server: Parameters<ArtifactHttpRoute["install"]>[0]): void {
        new ArtifactHttpRoute(this.service, {
            publicBaseUrl: this.#config().mcp.publicBaseUrl
        }).install(server);
    }

    async stop(): Promise<void> {
        await this.#service?.stop();
        this.#service = undefined;
        this.#bridge = undefined;
    }

    #resolveEndpoint(name: string, authorityInstance?: string) {
        if (name !== "host") return this.#instances.get(name)?.worker;
        if (authorityInstance === undefined || this.#bridge === undefined) return undefined;
        const authority = this.#instances.get(authorityInstance);
        if (authority === undefined) return undefined;
        const snapshot = authority.worker.snapshot();
        return this.#bridge.endpointFor({
            appendControlEvent: async (type, data) => await authority.worker.appendControlEvent(type, data),
            authorityInstance,
            provider: authority.provider,
            securityMode: snapshot.effectiveSecurityMode ?? "disabled",
            workspace: authority.workspace
        });
    }
}

function artifactShareUrl(config: ControlConfig, token: string): string {
    if (!config.mcp.enabled) {
        throw createError({
            code: errorCodes.controlConfigValidationFailed,
            message: "Artifact sharing requires the MCP HTTP host to be enabled.",
            retryable: false
        });
    }
    const localHost = normalizeArtifactHttpHost(config.mcp.listenHost);
    const base = new URL(config.mcp.publicBaseUrl ?? `http://${localHost}:${config.mcp.listenPort}`);
    base.pathname = `${artifactShareRoute(base.toString())}/${encodeURIComponent(token)}`;
    base.search = "";
    base.hash = "";
    return base.toString();
}

function normalizeArtifactHttpHost(host: string): string {
    if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
    return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

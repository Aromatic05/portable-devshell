import { join } from "node:path";

import type {
    AgentProvider,
    AgentProviderHandle,
    AgentProviderStartContext,
    AgentProviderWebHandle,
    AgentProviderWebStartContext,
} from "../../../builtin/provider/AgentProvider.js";
import {
    PI_BOOTSTRAP_VERSION,
    PiProviderInstaller,
    type PiProviderInstallation,
} from "../install/ProviderInstaller.js";
import {
    PiAgentProcessFactory,
    type PiAgentRuntimeFactory,
} from "./AgentProcess.js";

export const PI_PROVIDER_ID = "pi";
export const PI_PROVIDER_VERSION = "0.1.3";
export const PI_SDK_ENTRYPOINT_ENV = "PORTABLE_DEVSHELL_PI_SDK_ENTRYPOINT";

export interface PiProviderInstallerLike {
    ensureInstalled(
        runtime: AgentProviderStartContext["runtime"],
    ): Promise<PiProviderInstallation>;
}

export interface PiAgentProviderOptions {
    installer?: PiProviderInstallerLike;
    piBootstrapVersion?: string;
    runtimeFactory?: PiAgentRuntimeFactory;
    version?: string;
}

export class PiAgentProvider implements AgentProvider {
    readonly id = PI_PROVIDER_ID;
    readonly version: string;
    readonly #installer: PiProviderInstallerLike;
    readonly #runtimeFactory: PiAgentRuntimeFactory;

    constructor(options: PiAgentProviderOptions = {}) {
        this.version = options.version ?? PI_PROVIDER_VERSION;
        this.#installer =
            options.installer ??
            new PiProviderInstaller({
                version: options.piBootstrapVersion ?? PI_BOOTSTRAP_VERSION,
            });
        this.#runtimeFactory =
            options.runtimeFactory ?? new PiAgentProcessFactory();
    }

    async start(
        context: AgentProviderStartContext,
    ): Promise<AgentProviderHandle> {
        const installation = await this.#installer.ensureInstalled(
            context.runtime,
        );
        const paths = resolvePiAgentPaths(context);
        return await this.#runtimeFactory.start({
            agentId: context.agentId,
            agentDirectory: installation.agentDirectory,
            entrypoint: installation.entrypoint,
            localCwd: paths.localCwd,
            managedInstallRoot: installation.managedInstallRoot,
            moduleRoot: installation.moduleRoot,
            processes: context.processes,
            runtimeDirectory: context.runtime.stateDirectory,
            target: context.target,
            tools: context.tools,
            webBasePath: context.web?.basePath ?? "/agent/",
        });
    }

    async startWeb(
        context: AgentProviderWebStartContext,
    ): Promise<AgentProviderWebHandle> {
        const installation = await this.#installer.ensureInstalled(
            context.runtime,
        );
        return await this.#runtimeFactory.startWeb({
            agentDirectory: installation.agentDirectory,
            entrypoint: installation.entrypoint,
            managedInstallRoot: installation.managedInstallRoot,
            moduleRoot: installation.moduleRoot,
            processes: context.processes,
            runtimeDirectory: context.runtime.stateDirectory,
            webBasePath: context.web.basePath,
        });
    }
}

function resolvePiAgentPaths(context: AgentProviderStartContext): {
    localCwd: string;
} {
    const agentRoot = join(
        context.runtime.stateDirectory,
        "agents",
        context.agentId,
    );
    return {
        localCwd: join(agentRoot, "cwd"),
    };
}

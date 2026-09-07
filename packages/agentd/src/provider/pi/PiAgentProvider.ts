import { join } from "node:path";

import type {
    AgentProvider,
    AgentProviderHandle,
    AgentProviderStartContext
} from "../AgentProvider.js";
import {
    PiProviderInstaller,
    type PiProviderInstallation
} from "./PiProviderInstaller.js";
import {
    PiAgentProcessFactory,
    type PiAgentRuntimeFactory
} from "./PiAgentProcess.js";

export const PI_PROVIDER_ID = "pi";
export const PI_PROVIDER_VERSION = "0.84.4";

export interface PiProviderInstallerLike {
    ensureInstalled(runtime: AgentProviderStartContext["runtime"]): Promise<PiProviderInstallation>;
}

export interface PiAgentProviderOptions {
    installer?: PiProviderInstallerLike;
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
        this.#installer = options.installer ?? new PiProviderInstaller({ version: this.version });
        this.#runtimeFactory = options.runtimeFactory ?? new PiAgentProcessFactory();
    }

    async start(context: AgentProviderStartContext): Promise<AgentProviderHandle> {
        const installation = await this.#installer.ensureInstalled(context.runtime);
        const paths = resolvePiAgentPaths(context);
        return await this.#runtimeFactory.start({
            agentId: context.agentId,
            entrypoint: installation.entrypoint,
            localCwd: paths.localCwd,
            runtimeDirectory: context.runtime.stateDirectory,
            target: context.target,
            webBasePath: context.web?.basePath ?? "/agent/"
        });
    }
}

function resolvePiAgentPaths(context: AgentProviderStartContext): { localCwd: string } {
    const agentRoot = join(context.runtime.stateDirectory, "agents", context.agentId);
    return {
        localCwd: join(agentRoot, "cwd")
    };
}

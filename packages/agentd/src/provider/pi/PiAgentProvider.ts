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
        const tools = await context.worker.listTools();
        return await this.#runtimeFactory.start({
            agentDir: paths.agentDir,
            callTool: async (toolName, input, options) => await context.worker.callTool(toolName, input, options),
            entrypoint: installation.entrypoint,
            localCwd: paths.localCwd,
            remoteWorkspace: `${context.target.instance}:${context.target.workspace}`,
            sessionDir: paths.sessionDir,
            tools
        });
    }
}

function resolvePiAgentPaths(context: AgentProviderStartContext): {
    agentDir: string;
    localCwd: string;
    sessionDir: string;
} {
    const agentRoot = join(context.runtime.stateDirectory, "agents", context.agentId);
    return {
        agentDir: context.runtime.stateDirectory,
        localCwd: join(agentRoot, "cwd"),
        sessionDir: join(agentRoot, "sessions")
    };
}

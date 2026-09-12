import { join } from "node:path";

import type { AgentProvider, AgentProviderHandle, AgentProviderStartContext } from "../../builtin/provider/AgentProvider.js";
import {
    OpenCodeAgentProcessFactory,
    type OpenCodeAgentRuntimeFactory
} from "./OpenCodeAgentProcess.js";
import {
    OPENCODE_RUNTIME_VERSION,
    OpenCodeProviderInstaller,
    type OpenCodeProviderInstallation
} from "./OpenCodeProviderInstaller.js";

export const OPENCODE_PROVIDER_ID = "opencode";
export const OPENCODE_PROVIDER_VERSION = "0.1.0";

export interface OpenCodeProviderInstallerLike {
    ensureInstalled(runtime: AgentProviderStartContext["runtime"]): Promise<OpenCodeProviderInstallation>;
}

export interface OpenCodeAgentProviderOptions {
    installer?: OpenCodeProviderInstallerLike;
    openCodeRuntimeVersion?: string;
    runtimeFactory?: OpenCodeAgentRuntimeFactory;
    version?: string;
}

export class OpenCodeAgentProvider implements AgentProvider {
    readonly id = OPENCODE_PROVIDER_ID;
    readonly version: string;
    readonly #installer: OpenCodeProviderInstallerLike;
    readonly #runtimeFactory: OpenCodeAgentRuntimeFactory;

    constructor(options: OpenCodeAgentProviderOptions = {}) {
        this.version = options.version ?? OPENCODE_PROVIDER_VERSION;
        this.#installer = options.installer ?? new OpenCodeProviderInstaller({
            version: options.openCodeRuntimeVersion ?? OPENCODE_RUNTIME_VERSION
        });
        this.#runtimeFactory = options.runtimeFactory ?? new OpenCodeAgentProcessFactory();
    }

    async start(context: AgentProviderStartContext): Promise<AgentProviderHandle> {
        const installation = await this.#installer.ensureInstalled(context.runtime);
        return await this.#runtimeFactory.start({
            agentId: context.agentId,
            command: installation.command,
            localCwd: join(context.runtime.stateDirectory, "agents", context.agentId, "cwd"),
            processes: context.processes,
            stateDirectory: context.runtime.stateDirectory,
            target: context.target,
            tools: context.tools
        });
    }
}

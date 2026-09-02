import { mkdir } from "node:fs/promises";
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
    PiSdkLoader,
    type PiSdkModule,
    type PiSessionLike
} from "./PiSdkLoader.js";
import { createPiWorkerTools } from "./PiWorkerTools.js";

export const PI_PROVIDER_ID = "pi";
export const PI_PROVIDER_VERSION = "0.84.4";

export interface PiProviderInstallerLike {
    ensureInstalled(runtime: AgentProviderStartContext["runtime"]): Promise<PiProviderInstallation>;
}

export interface PiSdkLoaderLike {
    load(entrypoint: string): Promise<PiSdkModule>;
}

export interface PiAgentProviderOptions {
    installer?: PiProviderInstallerLike;
    loader?: PiSdkLoaderLike;
    version?: string;
}

export class PiAgentProvider implements AgentProvider {
    readonly id = PI_PROVIDER_ID;
    readonly version: string;
    readonly #installer: PiProviderInstallerLike;
    readonly #loader: PiSdkLoaderLike;

    constructor(options: PiAgentProviderOptions = {}) {
        this.version = options.version ?? PI_PROVIDER_VERSION;
        this.#installer = options.installer ?? new PiProviderInstaller({ version: this.version });
        this.#loader = options.loader ?? new PiSdkLoader();
    }

    async start(context: AgentProviderStartContext): Promise<AgentProviderHandle> {
        const installation = await this.#installer.ensureInstalled(context.runtime);
        const sdk = await this.#loader.load(installation.entrypoint);
        const paths = resolvePiAgentPaths(context);
        await Promise.all([
            mkdir(paths.agentDir, { recursive: true }),
            mkdir(paths.localCwd, { recursive: true }),
            mkdir(paths.sessionDir, { recursive: true })
        ]);

        const resourceLoader = new sdk.DefaultResourceLoader({
            agentDir: paths.agentDir,
            cwd: paths.localCwd,
            systemPromptOverride: (basePrompt: string | undefined) => appendRemoteWorkspacePrompt(
                basePrompt,
                context
            )
        });
        await resourceLoader.reload();

        const customTools = await createPiWorkerTools(context.worker);
        const sessionManager = sdk.SessionManager.create(paths.localCwd, paths.sessionDir);
        const { session } = await sdk.createAgentSession({
            agentDir: paths.agentDir,
            customTools,
            cwd: paths.localCwd,
            noTools: "builtin",
            resourceLoader,
            sessionManager,
            tools: customTools.map((tool) => tool.name)
        });

        return new PiAgentHandle(session);
    }
}

class PiAgentHandle implements AgentProviderHandle {
    readonly #session: PiSessionLike;
    #disposed = false;

    constructor(session: PiSessionLike) {
        this.#session = session;
    }

    async prompt(message: string): Promise<void> {
        this.#assertActive();
        await this.#session.prompt(message);
    }

    async steer(message: string): Promise<void> {
        this.#assertActive();
        await this.#session.prompt(message, { streamingBehavior: "steer" });
    }

    async followUp(message: string): Promise<void> {
        this.#assertActive();
        await this.#session.prompt(message, { streamingBehavior: "followUp" });
    }

    async abort(): Promise<void> {
        this.#assertActive();
        await this.#session.abort();
    }

    async stop(): Promise<void> {
        if (this.#disposed) {
            return;
        }
        await this.#session.abort().catch(() => undefined);
        this.#session.dispose();
        this.#disposed = true;
    }

    #assertActive(): void {
        if (this.#disposed) {
            throw new Error("Pi Agent session is already stopped.");
        }
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

function appendRemoteWorkspacePrompt(
    basePrompt: string | undefined,
    context: AgentProviderStartContext
): string {
    const remote = `${context.target.instance}:${context.target.workspace}`;
    const devshellPrompt = [
        "portable-devshell execution environment:",
        `- The real project workspace is ${remote}.`,
        "- Your local process cwd is only Pi runtime state. It is not the project workspace.",
        "- Use the provided devshell Worker tools for every project filesystem, shell, process, and artifact operation.",
        "- Do not attempt to access the project with local Node.js filesystem/process APIs.",
        "- Tool results come directly from the Worker attached to the real project workspace."
    ].join("\n");
    return basePrompt === undefined || basePrompt.length === 0
        ? devshellPrompt
        : `${basePrompt}\n\n${devshellPrompt}`;
}

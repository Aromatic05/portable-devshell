import { AgentHost, type AgentHostRecord } from "./host/AgentHost.js";
import { AgentProviderRegistry } from "./provider/AgentProviderRegistry.js";
import type { AgentProvider } from "./provider/AgentProvider.js";
import { parseAgentWorkerTarget } from "./worker/AgentWorkerTarget.js";
import type {
    ExtensionContext,
    ExtensionJsonValue,
} from "@portable-devshell/extension";

import { readAgentId, readMessageInput, readStartInput } from "./AgentInput.js";
import { openAgentToolSession } from "./AgentToolAdapter.js";

export const AGENT_WEB_RELATIVE_PATH = "extensions/agent/";

export interface AgentExtensionRuntimeOptions {
    providers?: readonly AgentProvider[];
    registry?: AgentProviderRegistry;
    resolveProvider?: (requested?: string) => Promise<string>;
}

export class AgentExtensionRuntime {
    readonly #context: ExtensionContext;
    readonly #host: AgentHost;
    readonly #providers: AgentProviderRegistry;
    readonly #resolveProvider?: (requested?: string) => Promise<string>;

    constructor(
        context: ExtensionContext,
        options: AgentExtensionRuntimeOptions = {},
    ) {
        this.#context = context;
        const processes = context.capabilities.processes;
        if (processes === undefined)
            throw new Error(
                "Agent Extension requires the processes capability.",
            );
        this.#providers =
            options.registry ??
            new AgentProviderRegistry(options.providers ?? []);
        this.#resolveProvider = options.resolveProvider;
        this.#host = new AgentHost({
            processes,
            registry: this.#providers,
            runtimeRootDirectory: context.paths.stateDirectory,
            webBasePath: "/",
        });
    }

    list(): AgentHostRecord[] {
        return this.#host.list();
    }

    get(agentId: string): AgentHostRecord | undefined {
        return this.#host.get(agentId);
    }

    isProviderInUse(providerId: string): boolean {
        return this.#host.isProviderInUse(providerId);
    }

    async start(
        value: ExtensionJsonValue | undefined,
    ): Promise<AgentHostRecord> {
        const input = readStartInput(value);
        const requested = parseAgentWorkerTarget(input.target);
        const provider = await this.#selectProvider(input.provider);
        const tools = await openAgentToolSession(this.#context, requested);
        return await this.#host.start({
            provider,
            target: tools.target,
            tools,
        });
    }

    async #selectProvider(requested?: string): Promise<string> {
        if (this.#resolveProvider !== undefined)
            return await this.#resolveProvider(requested);
        if (requested !== undefined) {
            this.#providers.require(requested);
            return requested;
        }
        const providers = this.#providers.list();
        if (providers.length === 1) return providers[0]!.id;
        if (providers.length === 0)
            throw new Error("No enabled Agent provider is available.");
        throw new Error(
            "Multiple Agent providers are enabled; select one with --provider.",
        );
    }

    async prompt(value: ExtensionJsonValue | undefined): Promise<void> {
        const input = readMessageInput(value);
        await this.#host.prompt(input.agentId, input.message);
    }

    async steer(value: ExtensionJsonValue | undefined): Promise<void> {
        const input = readMessageInput(value);
        await this.#host.steer(input.agentId, input.message);
    }

    async followUp(value: ExtensionJsonValue | undefined): Promise<void> {
        const input = readMessageInput(value);
        await this.#host.followUp(input.agentId, input.message);
    }

    async waitForIdle(value: ExtensionJsonValue | undefined): Promise<void> {
        await this.#host.waitForIdle(readAgentId(value));
    }

    async abort(value: ExtensionJsonValue | undefined): Promise<void> {
        await this.#host.abort(readAgentId(value));
    }

    async reload(value: ExtensionJsonValue | undefined): Promise<void> {
        await this.#host.reload(readAgentId(value));
    }

    async stop(
        value: ExtensionJsonValue | undefined,
    ): Promise<AgentHostRecord> {
        return await this.#host.stop(readAgentId(value));
    }

    webUpstream(): URL | undefined {
        const endpoint = this.#host.webEndpoint();
        return endpoint === undefined ? undefined : new URL(endpoint.upstream);
    }

    async dispose(): Promise<void> {
        await this.#host.stopAll();
    }
}

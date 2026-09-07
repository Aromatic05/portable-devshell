import {
    AgentHost,
    parseAgentWorkerTarget,
    type AgentHostRecord,
    type AgentProvider
} from "@portable-devshell/agentd";
import type { ExtensionContext, ExtensionJsonValue } from "@portable-devshell/extension";

import { readAgentId, readMessageInput, readStartInput } from "./AgentInput.js";
import { openAgentToolSession } from "./AgentToolAdapter.js";

export const AGENT_WEB_RELATIVE_PATH = "extensions/agent/";

export interface AgentExtensionRuntimeOptions {
    providers?: readonly AgentProvider[];
}

export class AgentExtensionRuntime {
    readonly #context: ExtensionContext;
    readonly #host: AgentHost;

    constructor(context: ExtensionContext, options: AgentExtensionRuntimeOptions = {}) {
        this.#context = context;
        this.#host = new AgentHost({
            providers: options.providers ?? [],
            runtimeRootDirectory: context.paths.stateDirectory,
            webBasePath: "/"
        });
    }

    list(): AgentHostRecord[] {
        return this.#host.list();
    }

    get(agentId: string): AgentHostRecord | undefined {
        return this.#host.get(agentId);
    }

    async start(value: ExtensionJsonValue | undefined): Promise<AgentHostRecord> {
        const input = readStartInput(value);
        const requested = parseAgentWorkerTarget(input.target);
        const tools = await openAgentToolSession(this.#context, requested);
        return await this.#host.start({
            provider: input.provider ?? "pi",
            target: tools.target,
            tools
        });
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

    async abort(value: ExtensionJsonValue | undefined): Promise<void> {
        await this.#host.abort(readAgentId(value));
    }

    async reload(value: ExtensionJsonValue | undefined): Promise<void> {
        await this.#host.reload(readAgentId(value));
    }

    async stop(value: ExtensionJsonValue | undefined): Promise<AgentHostRecord> {
        return await this.#host.stop(readAgentId(value));
    }

    async retireInstance(instance: string): Promise<void> {
        const agentIds = this.#host.list()
            .filter((record) => record.target.instance === instance)
            .map((record) => record.agentId);
        const settled = await Promise.allSettled(agentIds.map(async (agentId) => await this.#host.stop(agentId)));
        const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `Agents bound to instance ${instance} failed to retire cleanly.`);
        }
    }

    webUpstream(): URL | undefined {
        const endpoint = this.#host.webEndpoint();
        return endpoint === undefined ? undefined : new URL(endpoint.upstream);
    }

    async dispose(): Promise<void> {
        await this.#host.stopAll();
    }
}

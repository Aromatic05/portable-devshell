import {
    AgentHost,
    AgentWorkerClientBinding,
    PiAgentProvider,
    parseAgentWorkerTarget,
    type AgentWorkerClient
} from "@portable-devshell/agentd";
import type {
    AgentMessageInput,
    AgentRecord,
    AgentStartInput
} from "@portable-devshell/shared";

import { InstanceConnectionService } from "../../control/instance/connection/InstanceConnectionService.js";
import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";

export interface ControlRuntimeAgentOptions {
    homeDirectory?: string;
    instances: InstanceRegistry;
    webBasePath?: string;
}

export class ControlRuntimeAgent {
    readonly #connections: InstanceConnectionService;
    readonly #host: AgentHost;

    constructor(options: ControlRuntimeAgentOptions) {
        this.#connections = new InstanceConnectionService(options.instances);
        this.#host = new AgentHost({
            homeDirectory: options.homeDirectory,
            providers: [new PiAgentProvider()],
            ...(options.webBasePath === undefined ? {} : { webBasePath: options.webBasePath }),
            workerFactory: async (target, agentId) => await this.#createWorkerBinding(target, agentId)
        });
    }

    list(): AgentRecord[] {
        return this.#host.list();
    }

    get(agentId: string): AgentRecord | undefined {
        return this.#host.get(agentId);
    }

    async start(input: AgentStartInput): Promise<AgentRecord> {
        return await this.#host.start({
            provider: input.provider ?? "pi",
            ...(input.slug === undefined ? {} : { slug: input.slug }),
            target: parseAgentWorkerTarget(input.target)
        });
    }

    async prompt(input: AgentMessageInput): Promise<void> {
        await this.#host.prompt(input.agentId, input.message);
    }

    async steer(input: AgentMessageInput): Promise<void> {
        await this.#host.steer(input.agentId, input.message);
    }

    async followUp(input: AgentMessageInput): Promise<void> {
        await this.#host.followUp(input.agentId, input.message);
    }

    async abort(agentId: string): Promise<void> {
        await this.#host.abort(agentId);
    }

    async stop(agentId: string): Promise<AgentRecord> {
        return await this.#host.stop(agentId);
    }

    async stopAll(): Promise<void> {
        await this.#host.stopAll();
    }

    async retireInstance(instance: string): Promise<void> {
        const agentIds = this.#host.list()
            .filter((record) => record.target.instance === instance)
            .map((record) => record.agentId);
        const failures: unknown[] = [];
        for (const agentId of agentIds) {
            await this.#host.stop(agentId).catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, `Agents bound to instance ${instance} failed to retire cleanly.`);
        }
    }

    async #createWorkerBinding(
        target: ReturnType<typeof parseAgentWorkerTarget>,
        agentId: string
    ): Promise<AgentWorkerClient> {
        const reference = `agent:${agentId}`;
        const lease = await this.#connections.acquire(target.instance, reference);
        const binding = new AgentWorkerClientBinding({ agentId, handle: lease.handle, target });
        let closed = false;
        return {
            target,
            callTool: async (...args) => await binding.callTool(...args),
            listTools: async () => await binding.listTools(),
            close: async () => {
                if (closed) return;
                closed = true;
                try {
                    await binding.close();
                } finally {
                    await this.#connections.release(target.instance, reference);
                }
            }
        };
    }
}

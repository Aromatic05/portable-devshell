import { randomUUID } from "node:crypto";

import {
    AgentHost,
    PiAgentProvider,
    parseAgentWorkerTarget
} from "@portable-devshell/agentd";
import type { WorkerHandle } from "@portable-devshell/core";
import {
    createError,
    errorCodes,
    type AgentMessageInput,
    type AgentRecord,
    type AgentStartInput,
    type AgentToolSessionCallInput,
    type AgentToolSessionOpenInput,
    type AgentToolSessionRecord,
    type AgentToolSessionToolsResult,
    type JsonValue
} from "@portable-devshell/shared";

import { InstanceConnectionService } from "../../control/instance/connection/InstanceConnectionService.js";
import type { InstanceDescriptor } from "../../control/instance/InstanceDescriptor.js";
import type { InstanceRegistry } from "../../control/instance/registry/InstanceRegistry.js";

type AgentToolSessionInstanceDescriptor = Pick<InstanceDescriptor, "enabled" | "name" | "provider">;

export function resolveAgentToolSessionInstance(
    descriptors: readonly AgentToolSessionInstanceDescriptor[],
    instance?: string
): string {
    if (instance !== undefined) return instance;
    const enabled = descriptors.filter((descriptor) => descriptor.enabled);
    const local = enabled.filter((descriptor) => descriptor.provider === "local");
    if (local.length === 1) return local[0]!.name;
    if (enabled.length === 1) return enabled[0]!.name;
    throw createError({
        code: errorCodes.targetInvalid,
        details: { instanceCount: enabled.length, localInstanceCount: local.length },
        message: enabled.length === 0
            ? "No devshell instances are configured. Set DEVSHELL_AGENT_TARGET=<instance>:<workspace>."
            : "Multiple devshell instances are configured without one unique local instance. Set DEVSHELL_AGENT_TARGET=<instance>:<workspace>.",
        retryable: false
    });
}

export interface ControlRuntimeAgentOptions {
    homeDirectory?: string;
    instances: InstanceRegistry;
    webBasePath?: string;
}

interface ControlAgentToolSession {
    connectionId: string;
    handle: WorkerHandle;
    reference: string;
    sessionId: string;
    target: {
        instance: string;
        workspace: string;
    };
}

export class ControlRuntimeAgent {
    readonly #connections: InstanceConnectionService;
    readonly #host: AgentHost;
    readonly #instances: InstanceRegistry;
    readonly #toolSessions = new Map<string, ControlAgentToolSession>();

    constructor(options: ControlRuntimeAgentOptions) {
        this.#instances = options.instances;
        this.#connections = new InstanceConnectionService(options.instances);
        this.#host = new AgentHost({
            homeDirectory: options.homeDirectory,
            providers: [new PiAgentProvider()],
            ...(options.webBasePath === undefined ? {} : { webBasePath: options.webBasePath })
        });
    }

    list(): AgentRecord[] {
        return this.#host.list();
    }

    get(agentId: string): AgentRecord | undefined {
        return this.#host.get(agentId);
    }

    webEndpoint(): { basePath: string; upstream: string } | undefined {
        return this.#host.webEndpoint();
    }

    async start(input: AgentStartInput): Promise<AgentRecord> {
        return await this.#host.start({
            provider: input.provider ?? "pi",
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

    async openToolSession(
        input: AgentToolSessionOpenInput,
        connectionId: string
    ): Promise<AgentToolSessionRecord> {
        const sessionId = `ats-${randomUUID()}`;
        const reference = `agent-tool:${sessionId}`;
        const instance = resolveAgentToolSessionInstance(this.#instances.list(), input.instance);
        const lease = await this.#connections.acquire(instance, reference);
        try {
            const prepared = await lease.handle.prepareWorkspace(input.workspace);
            const session: ControlAgentToolSession = {
                connectionId,
                handle: lease.handle,
                reference,
                sessionId,
                target: {
                    instance,
                    workspace: prepared.workspace
                }
            };
            this.#toolSessions.set(sessionId, session);
            return { sessionId, target: { ...session.target } };
        } catch (error) {
            await this.#connections.release(instance, reference).catch(() => undefined);
            throw error;
        }
    }

    async listToolSessionTools(
        sessionId: string,
        connectionId: string
    ): Promise<AgentToolSessionToolsResult> {
        const session = this.#requireToolSession(sessionId, connectionId);
        return {
            tools: session.handle.listTools().map((tool) => ({
                ...tool,
                requiredCapabilities: [...tool.requiredCapabilities]
            }))
        };
    }

    async callToolSession(
        input: AgentToolSessionCallInput,
        connectionId: string,
        signal?: AbortSignal
    ): Promise<JsonValue> {
        const session = this.#requireToolSession(input.sessionId, connectionId);
        return await session.handle.callTool(
            input.toolName,
            input.input,
            {
                ctxId: session.sessionId,
                requestId: input.operationId,
                source: "agent",
                workspace: session.target.workspace
            },
            signal
        );
    }

    async closeToolSession(sessionId: string, connectionId: string): Promise<void> {
        await this.#closeToolSession(this.#requireToolSession(sessionId, connectionId));
    }

    async connectionClosed(connectionId: string): Promise<void> {
        for (const session of [...this.#toolSessions.values()]) {
            if (session.connectionId !== connectionId) continue;
            await this.#closeToolSession(session).catch(() => undefined);
        }
    }

    async stop(agentId: string): Promise<AgentRecord> {
        return await this.#host.stop(agentId);
    }

    async stopAll(): Promise<void> {
        const failures: unknown[] = [];
        await this.#host.stopAll().catch((error) => failures.push(error));
        for (const session of [...this.#toolSessions.values()]) {
            await this.#closeToolSession(session).catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "Agent runtime failed to stop cleanly.");
        }
    }

    async retireInstance(instance: string): Promise<void> {
        const agentIds = this.#host.list()
            .filter((record) => record.target.instance === instance)
            .map((record) => record.agentId);
        const failures: unknown[] = [];
        for (const agentId of agentIds) {
            await this.#host.stop(agentId).catch((error) => failures.push(error));
        }
        for (const session of [...this.#toolSessions.values()]) {
            if (session.target.instance !== instance) continue;
            await this.#closeToolSession(session).catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, `Agents bound to instance ${instance} failed to retire cleanly.`);
        }
    }

    #requireToolSession(sessionId: string, connectionId: string): ControlAgentToolSession {
        const session = this.#toolSessions.get(sessionId);
        if (session !== undefined && session.connectionId === connectionId) return session;
        throw createError({
            code: errorCodes.agentToolSessionMissing,
            details: { sessionId },
            message: `Agent tool session ${sessionId} was not found.`,
            retryable: false
        });
    }

    async #closeToolSession(session: ControlAgentToolSession): Promise<void> {
        if (this.#toolSessions.get(session.sessionId) !== session) return;
        this.#toolSessions.delete(session.sessionId);
        const failures: unknown[] = [];
        await session.handle.releaseToolSession(session.sessionId).catch((error) => failures.push(error));
        await this.#connections.release(session.target.instance, session.reference).catch((error) => failures.push(error));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
            throw new AggregateError(failures, `Agent tool session ${session.sessionId} failed to close cleanly.`);
        }
    }
}

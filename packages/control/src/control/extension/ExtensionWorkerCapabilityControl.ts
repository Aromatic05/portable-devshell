import { randomUUID } from "node:crypto";

import type {
    ExtensionJsonValue,
    ExtensionToolDefinition,
    ExtensionWorkerCapability,
    ExtensionWorkerOpenInput,
    ExtensionWorkerSession
} from "@portable-devshell/extension";
import type { JsonValue } from "@portable-devshell/shared";

import {
    InstanceConnectionService,
    type InstanceConnectionLease
} from "../instance/connection/InstanceConnectionService.js";
import type { InstanceDescriptor } from "../instance/InstanceDescriptor.js";
import type { InstanceRegistry } from "../instance/registry/InstanceRegistry.js";

interface ExtensionWorkerConnectionPort {
    acquire(instance: string, reference: string): Promise<InstanceConnectionLease>;
    release(instance: string, reference: string): Promise<void>;
}

type ExtensionWorkerDescriptor = Pick<InstanceDescriptor, "enabled" | "name" | "provider">;

interface ManagedExtensionWorkerSession {
    instance: string;
    reference: string;
    sessionId: string;
    session: ExtensionWorkerSession;
}

export interface ExtensionWorkerCapabilityControlOptions {
    allowed: boolean;
    connections?: ExtensionWorkerConnectionPort;
    extensionId: string;
    generation: string;
    instances: InstanceRegistry;
}

export class ExtensionWorkerCapabilityControl implements ExtensionWorkerCapability {
    readonly #allowed: boolean;
    readonly #connections: ExtensionWorkerConnectionPort;
    readonly #extensionId: string;
    readonly #generation: string;
    readonly #instances: InstanceRegistry;
    readonly #sessions = new Map<string, ManagedExtensionWorkerSession>();
    #closed = false;

    constructor(options: ExtensionWorkerCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#connections = options.connections ?? new InstanceConnectionService(options.instances);
        this.#extensionId = options.extensionId;
        this.#generation = options.generation;
        this.#instances = options.instances;
    }

    async openSession(input: ExtensionWorkerOpenInput): Promise<ExtensionWorkerSession> {
        if (!this.#allowed) {
            throw new Error(`Extension ${this.#extensionId} did not declare the worker capability.`);
        }
        if (this.#closed) throw new Error(`Extension ${this.#extensionId} worker capability is closed.`);
        if (input.workspace.length === 0) throw new TypeError("Extension worker workspace must not be empty.");

        const instance = resolveExtensionWorkerInstance(this.#instances.list(), input.instance);
        const sessionId = `ext-${randomUUID()}`;
        const reference = `extension-worker:${this.#extensionId}:${this.#generation}:${sessionId}`;
        const lease = await this.#connections.acquire(instance, reference);
        try {
            const prepared = await lease.worker.prepareWorkspace(input.workspace);
            let closed = false;
            const close = async () => {
                if (closed) return;
                closed = true;
                this.#sessions.delete(sessionId);
                const failures: unknown[] = [];
                await lease.worker.releaseToolSession(sessionId).catch((error) => failures.push(error));
                await this.#connections.release(instance, reference).catch((error) => failures.push(error));
                if (failures.length === 1) throw failures[0];
                if (failures.length > 1) {
                    throw new AggregateError(failures, `Extension worker session ${sessionId} failed to close cleanly.`);
                }
            };
            const session: ExtensionWorkerSession = {
                instance,
                workspace: prepared.workspace,
                callTool: async (toolName, toolInput, options = {}) => await lease.worker.callTool(
                    toolName,
                    toolInput as JsonValue,
                    {
                        ctxId: sessionId,
                        extensionId: this.#extensionId,
                        ...(options.operationId === undefined ? {} : { requestId: options.operationId }),
                        source: "extension",
                        workspace: prepared.workspace
                    },
                    options.signal
                ) as ExtensionJsonValue,
                close,
                listTools: () => lease.worker.listTools().map(toExtensionToolDefinition)
            };
            this.#sessions.set(sessionId, { instance, reference, session, sessionId });
            return session;
        } catch (error) {
            await lease.worker.releaseToolSession(sessionId).catch(() => undefined);
            await this.#connections.release(instance, reference).catch(() => undefined);
            throw error;
        }
    }

    async retireInstance(instance: string): Promise<void> {
        const sessions = [...this.#sessions.values()].filter((candidate) => candidate.instance === instance);
        const settled = await Promise.allSettled(sessions.map(async (candidate) => await candidate.session.close()));
        throwAggregateFailures(settled, `Extension ${this.#extensionId} worker sessions failed to retire instance ${instance}.`);
    }

    async closeAll(): Promise<void> {
        if (this.#closed) return;
        this.#closed = true;
        const settled = await Promise.allSettled(
            [...this.#sessions.values()].map(async (candidate) => await candidate.session.close())
        );
        throwAggregateFailures(settled, `Extension ${this.#extensionId} worker sessions failed to close.`);
    }
}

export function resolveExtensionWorkerInstance(
    descriptors: readonly ExtensionWorkerDescriptor[],
    instance?: string
): string {
    if (instance !== undefined) return instance;
    const enabled = descriptors.filter((descriptor) => descriptor.enabled);
    const local = enabled.filter((descriptor) => descriptor.provider === "local");
    if (local.length === 1) return local[0]!.name;
    if (enabled.length === 1) return enabled[0]!.name;
    throw new Error(
        enabled.length === 0
            ? "No enabled devshell instance is available for this Extension."
            : "Multiple enabled devshell instances are available and no unique local instance can be selected."
    );
}

function toExtensionToolDefinition(tool: {
    description: string;
    inputSchema: JsonValue;
    name: string;
}): ExtensionToolDefinition {
    return {
        description: tool.description,
        inputSchema: tool.inputSchema as ExtensionJsonValue,
        name: tool.name
    };
}

function throwAggregateFailures(
    settled: readonly PromiseSettledResult<void>[],
    message: string
): void {
    const failures = settled.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
}

import { randomUUID } from "node:crypto";

import type { ExtensionJsonValue } from "@portable-devshell/extension";
import type {
    ExtensionWorkerCapability,
    ExtensionWorkerEnvironment,
    ExtensionWorkerOpenInput,
    ExtensionWorkerSession,
    ExtensionWorkerToolDefinition,
} from "@portable-devshell/extension/worker";
import type { ToolCallHookValue } from "@portable-devshell/core";
import type { JsonValue, ToolCallContext } from "@portable-devshell/shared";

import type { InstanceDescriptor } from "@portable-devshell/core";
import { InstanceConnectionService } from "@portable-devshell/core";
import type { InstanceConnectionLease } from "@portable-devshell/core";
import type { InstanceRegistry } from "@portable-devshell/core";

interface ExtensionWorkerConnectionPort {
    acquire(
        instance: string,
        reference: string,
    ): Promise<InstanceConnectionLease>;
    release(instance: string, reference: string): Promise<void>;
}

type ExtensionWorkerDescriptor = Pick<
    InstanceDescriptor,
    "enabled" | "name" | "provider"
>;

interface ManagedExtensionWorkerSession {
    instance: string;
    reference: string;
    sessionId: string;
    session: ExtensionWorkerSession;
}

export interface ExtensionWorkerToolCallPort {
    callTool(
        instance: string,
        toolName: string,
        input: JsonValue,
        context: ToolCallContext,
        signal?: AbortSignal,
        transformResult?: (
            result: JsonValue,
            callId: string,
        ) => Promise<JsonValue>,
        invocationInput?: (
            input: JsonValue,
            callId: string,
            finalValue: ToolCallHookValue,
        ) => Promise<JsonValue> | JsonValue,
        onProgress?: (progress: JsonValue) => void,
        recording?: "caller" | "host",
    ): Promise<JsonValue>;
}

export interface ExtensionWorkerCapabilityControlOptions {
    allowed: boolean;
    authority: "worker.delegate" | "worker.execute";
    connections?: ExtensionWorkerConnectionPort;
    extensionId: string;
    generation: string;
    instances: InstanceRegistry;
    toolCalls: ExtensionWorkerToolCallPort;
}

export class ExtensionWorkerCapabilityControl implements ExtensionWorkerCapability {
    readonly #allowed: boolean;
    readonly #authority: ExtensionWorkerCapabilityControlOptions["authority"];
    readonly #connections: ExtensionWorkerConnectionPort;
    readonly #extensionId: string;
    readonly #generation: string;
    readonly #instanceEpochs = new Map<string, number>();
    readonly #instances: InstanceRegistry;
    readonly #recording: "caller" | "host";
    readonly #retiringInstances = new Set<string>();
    readonly #sessions = new Map<string, ManagedExtensionWorkerSession>();
    readonly #toolCalls: ExtensionWorkerToolCallPort;
    #closed = false;

    constructor(options: ExtensionWorkerCapabilityControlOptions) {
        this.#allowed = options.allowed;
        this.#authority = options.authority;
        this.#connections =
            options.connections ??
            new InstanceConnectionService(options.instances);
        this.#extensionId = options.extensionId;
        this.#generation = options.generation;
        this.#instances = options.instances;
        this.#recording =
            options.authority === "worker.delegate" ? "caller" : "host";
        this.#toolCalls = options.toolCalls;
    }

    async openSession(
        input: ExtensionWorkerOpenInput,
    ): Promise<ExtensionWorkerSession> {
        if (!this.#allowed) {
            throw new Error(
                `Extension ${this.#extensionId} did not declare the ${this.#authority} capability.`,
            );
        }
        if (this.#closed)
            throw new Error(
                `Extension ${this.#extensionId} ${this.#authority} capability is closed.`,
            );
        if (input.workspace.length === 0)
            throw new TypeError(
                "Extension worker workspace must not be empty.",
            );

        const instance = resolveExtensionWorkerInstance(
            this.#instances.list(),
            input.instance,
        );
        if (this.#retiringInstances.has(instance)) {
            throw new Error(
                `Extension ${this.#extensionId} Worker instance ${instance} is retiring.`,
            );
        }
        const instanceEpoch = this.#instanceEpochs.get(instance) ?? 0;
        const sessionId = `ext-${randomUUID()}`;
        const reference = `extension-worker:${this.#extensionId}:${this.#generation}:${sessionId}`;
        const lease = await this.#connections.acquire(instance, reference);
        try {
            const environment = extensionWorkerEnvironment(
                lease.worker.handshake,
            );
            const prepared = await lease.worker.prepareWorkspace(
                input.workspace,
            );
            if (
                this.#closed ||
                this.#retiringInstances.has(instance) ||
                (this.#instanceEpochs.get(instance) ?? 0) !== instanceEpoch
            ) {
                throw new Error(
                    this.#closed
                        ? `Extension ${this.#extensionId} ${this.#authority} capability closed while opening a session.`
                        : `Extension ${this.#extensionId} Worker instance ${instance} retired while opening a session.`,
                );
            }
            let closePromise: Promise<void> | undefined;
            let toolSessionReleased = false;
            let connectionReleased = false;
            let closeCompleted = false;
            let resolveClosed!: () => void;
            const closed = new Promise<void>((resolve) => {
                resolveClosed = resolve;
            });
            const close = async () => {
                if (closeCompleted) return;
                if (closePromise !== undefined) return await closePromise;
                const attempt = (async () => {
                    const failures: unknown[] = [];
                    if (!toolSessionReleased) {
                        try {
                            await lease.worker.releaseToolSession(sessionId);
                            toolSessionReleased = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (!connectionReleased) {
                        try {
                            await this.#connections.release(
                                instance,
                                reference,
                            );
                            connectionReleased = true;
                        } catch (error) {
                            failures.push(error);
                        }
                    }
                    if (failures.length === 1) throw failures[0];
                    if (failures.length > 1) {
                        throw new AggregateError(
                            failures,
                            `Extension Worker session ${sessionId} failed to close cleanly.`,
                        );
                    }
                    closeCompleted = true;
                    this.#sessions.delete(sessionId);
                    resolveClosed();
                })();
                closePromise = attempt;
                try {
                    await attempt;
                } finally {
                    if (closePromise === attempt) closePromise = undefined;
                }
            };
            const session: ExtensionWorkerSession = {
                closed,
                environment,
                instance,
                workspace: prepared.workspace,
                callTool: async (toolName, toolInput, options = {}) => {
                    return (await this.#toolCalls.callTool(
                        instance,
                        toolName,
                        toolInput as JsonValue,
                        {
                            ctxId: sessionId,
                            ...(options.operationId === undefined
                                ? {}
                                : {
                                      operationId: options.operationId,
                                      requestId: options.operationId,
                                  }),
                            source: "extension",
                            workspace: prepared.workspace,
                        },
                        options.signal,
                        undefined,
                        undefined,
                        options.onProgress as
                            ((progress: JsonValue) => void) | undefined,
                        this.#recording,
                    )) as ExtensionJsonValue;
                },
                close,
                listTools: () =>
                    lease.worker
                        .listTools()
                        .map(toExtensionWorkerToolDefinition),
            };
            this.#sessions.set(sessionId, {
                instance,
                reference,
                session,
                sessionId,
            });
            return session;
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await lease.worker
                .releaseToolSession(sessionId)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await this.#connections
                .release(instance, reference)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${this.#extensionId} worker session failed to open and cleanup was incomplete.`,
            );
        }
    }

    async retireInstance(instance: string): Promise<void> {
        this.#instanceEpochs.set(
            instance,
            (this.#instanceEpochs.get(instance) ?? 0) + 1,
        );
        this.#retiringInstances.add(instance);
        try {
            const sessions = [...this.#sessions.values()].filter(
                (candidate) => candidate.instance === instance,
            );
            const settled = await Promise.allSettled(
                sessions.map(
                    async (candidate) => await candidate.session.close(),
                ),
            );
            throwAggregateFailures(
                settled,
                `Extension ${this.#extensionId} worker sessions failed to retire instance ${instance}.`,
            );
        } finally {
            this.#retiringInstances.delete(instance);
        }
    }

    async closeAll(): Promise<void> {
        if (this.#closed && this.#sessions.size === 0) return;
        this.#closed = true;
        const settled = await Promise.allSettled(
            [...this.#sessions.values()].map(
                async (candidate) => await candidate.session.close(),
            ),
        );
        throwAggregateFailures(
            settled,
            `Extension ${this.#extensionId} worker sessions failed to close.`,
        );
    }
}

export function resolveExtensionWorkerInstance(
    descriptors: readonly ExtensionWorkerDescriptor[],
    instance?: string,
): string {
    if (instance !== undefined) return instance;
    const enabled = descriptors.filter((descriptor) => descriptor.enabled);
    const local = enabled.filter(
        (descriptor) => descriptor.provider === "local",
    );
    if (local.length === 1) return local[0]!.name;
    if (enabled.length === 1) return enabled[0]!.name;
    throw new Error(
        enabled.length === 0
            ? "No enabled devshell instance is available for this Extension."
            : "Multiple enabled devshell instances are available and no unique local instance can be selected.",
    );
}

function extensionWorkerEnvironment(
    handshake: InstanceDescriptor["worker"]["handshake"],
): ExtensionWorkerEnvironment {
    if (handshake === undefined) {
        throw new Error(
            "Extension worker session opened without a Worker handshake.",
        );
    }
    return Object.freeze({
        homeDirectory: handshake.homeDirectory,
        platform: Object.freeze({
            arch: handshake.platform.arch,
            ...(handshake.platform.distribution === undefined
                ? {}
                : {
                      distribution: Object.freeze({
                          ...handshake.platform.distribution,
                      }),
                  }),
            os: handshake.platform.os,
            ...(handshake.platform.packageManager === undefined
                ? {}
                : {
                      packageManager: handshake.platform.packageManager,
                  }),
            ...(handshake.platform.shell === undefined
                ? {}
                : {
                      shell: Object.freeze({ ...handshake.platform.shell }),
                  }),
        }),
    });
}

function toExtensionWorkerToolDefinition(tool: {
    description: string;
    inputSchema: JsonValue;
    name: string;
}): ExtensionWorkerToolDefinition {
    return {
        description: tool.description,
        inputSchema: tool.inputSchema as ExtensionJsonValue,
        name: tool.name,
    };
}

function throwAggregateFailures(
    settled: readonly PromiseSettledResult<void>[],
    message: string,
): void {
    const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, message);
}

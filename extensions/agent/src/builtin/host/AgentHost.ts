import { randomUUID } from "node:crypto";

import type { ExtensionProcessCapability } from "@portable-devshell/extension";

import type {
    AgentProvider,
    AgentProviderHandle,
    AgentProviderWebHandle,
} from "../provider/AgentProvider.js";
import type { AgentToolSession } from "../provider/AgentToolSession.js";
import { AgentProviderRuntimePaths } from "../provider/AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../worker/AgentWorkerTarget.js";
import { AgentProviderRegistry } from "../provider/AgentProviderRegistry.js";

export type AgentHostState = "starting" | "running" | "stopping" | "stopped";

export interface AgentHostRecord {
    agentId: string;
    provider: string;
    providerVersion: string;
    state: AgentHostState;
    target: AgentWorkerTarget;
}

export interface AgentHostWebEndpoint {
    basePath: string;
    upstream: string;
}

export interface AgentHostStartOptions {
    provider: string;
    target: AgentWorkerTarget;
    tools: AgentToolSession;
}

export interface AgentHostOptions {
    idFactory?: () => string;
    processes: ExtensionProcessCapability;
    providers?: readonly AgentProvider[];
    registry?: AgentProviderRegistry;
    runtimeRootDirectory: string;
    webBasePath?: string;
}

interface AgentHostRuntime {
    cleanup?: Promise<AgentHostRecord>;
    handle: AgentProviderHandle;
    providerStopped?: boolean;
    record: AgentHostRecord;
    tools: AgentToolSession;
    toolsClosed?: boolean;
}

interface AgentHostWebRuntime {
    handle: AgentProviderWebHandle;
    provider: string;
}

export class AgentHost {
    readonly #idFactory: () => string;
    readonly #processes: ExtensionProcessCapability;
    readonly #registry: AgentProviderRegistry;
    readonly #runtimeRootDirectory: string;
    readonly #runtimes = new Map<string, AgentHostRuntime>();
    readonly #startingProviders = new Map<string, string>();
    readonly #webBasePath: string;
    #web?: AgentHostWebRuntime;
    #webStarting?: {
        provider: string;
        promise: Promise<AgentProviderWebHandle>;
    };

    constructor(options: AgentHostOptions) {
        this.#idFactory = options.idFactory ?? (() => `ag-${randomUUID()}`);
        this.#processes = options.processes;
        this.#registry =
            options.registry ?? new AgentProviderRegistry(options.providers);
        this.#runtimeRootDirectory = options.runtimeRootDirectory;
        this.#webBasePath = normalizeBasePath(options.webBasePath ?? "/agent");
    }

    get registry(): AgentProviderRegistry {
        return this.#registry;
    }

    list(): AgentHostRecord[] {
        return [...this.#runtimes.values()].map((runtime) =>
            cloneRecord(runtime.record),
        );
    }

    get(agentId: string): AgentHostRecord | undefined {
        const runtime = this.#runtimes.get(agentId);
        return runtime === undefined ? undefined : cloneRecord(runtime.record);
    }

    isProviderInUse(providerId: string): boolean {
        return (
            [...this.#startingProviders.values()].includes(providerId) ||
            [...this.#runtimes.values()].some(
                (runtime) => runtime.record.provider === providerId,
            )
        );
    }

    webEndpoint(): AgentHostWebEndpoint | undefined {
        if (this.#web !== undefined) {
            return this.#formatWebEndpoint(this.#web.handle.upstream);
        }
        const endpoints = [...this.#runtimes.values()]
            .map((runtime) => runtime.handle.web?.upstream.toString())
            .filter((upstream): upstream is string => upstream !== undefined);
        if (endpoints.length === 0) return undefined;
        const upstream = endpoints[0]!;
        if (endpoints.some((candidate) => candidate !== upstream)) {
            throw new Error(
                "Running Agent providers expose multiple Web endpoints; one /agent hub is required.",
            );
        }
        return this.#formatWebEndpoint(new URL(upstream));
    }

    async ensureWebEndpoint(
        providerId: string,
    ): Promise<AgentHostWebEndpoint | undefined> {
        if (this.#web !== undefined) {
            if (this.#web.provider !== providerId) {
                throw new Error(
                    `Agent Web hub is already owned by provider ${this.#web.provider}.`,
                );
            }
            return this.#formatWebEndpoint(this.#web.handle.upstream);
        }
        if (this.#webStarting !== undefined) {
            if (this.#webStarting.provider !== providerId) {
                throw new Error(
                    `Agent Web hub is already starting for provider ${this.#webStarting.provider}.`,
                );
            }
            const handle = await this.#webStarting.promise;
            return this.#formatWebEndpoint(handle.upstream);
        }

        const provider = this.#registry.require(providerId);
        if (provider.startWeb === undefined) return this.webEndpoint();
        const promise = provider.startWeb({
            processes: this.#processes,
            runtime: new AgentProviderRuntimePaths({
                provider: provider.id,
                rootDirectory: this.#runtimeRootDirectory,
                version: provider.version,
            }),
            web: { basePath: `${this.#webBasePath}/` },
        });
        this.#webStarting = { promise, provider: providerId };
        try {
            const handle = await promise;
            const runtime = { handle, provider: providerId };
            this.#web = runtime;
            void handle.closed.then(
                () => {
                    if (this.#web === runtime) this.#web = undefined;
                },
                (error) => {
                    if (this.#web === runtime) this.#web = undefined;
                    reportBackgroundError(error);
                },
            );
            return this.#formatWebEndpoint(handle.upstream);
        } finally {
            if (this.#webStarting?.promise === promise) {
                this.#webStarting = undefined;
            }
        }
    }

    async prompt(agentId: string, message: string): Promise<void> {
        await this.#requireRuntime(agentId).handle.prompt(message);
    }

    async steer(agentId: string, message: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.steer === undefined) {
            throw new Error(
                `Agent provider ${runtime.record.provider} does not support steering.`,
            );
        }
        await runtime.handle.steer(message);
    }

    async followUp(agentId: string, message: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.followUp === undefined) {
            throw new Error(
                `Agent provider ${runtime.record.provider} does not support follow-up messages.`,
            );
        }
        await runtime.handle.followUp(message);
    }

    async waitForIdle(agentId: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.waitForIdle === undefined) {
            throw new Error(
                `Agent provider ${runtime.record.provider} does not support waiting for idle.`,
            );
        }
        await runtime.handle.waitForIdle();
    }

    async reload(agentId: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.reload === undefined) {
            throw new Error(
                `Agent provider ${runtime.record.provider} does not support reload.`,
            );
        }
        await runtime.handle.reload();
    }

    async abort(agentId: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.abort === undefined) {
            throw new Error(
                `Agent provider ${runtime.record.provider} does not support abort.`,
            );
        }
        await runtime.handle.abort();
    }

    async start(options: AgentHostStartOptions): Promise<AgentHostRecord> {
        const agentId = this.#idFactory();
        if (
            this.#runtimes.has(agentId) ||
            this.#startingProviders.has(agentId)
        ) {
            throw new Error(`Agent id already exists: ${agentId}`);
        }

        let provider: AgentProvider;
        let handle: AgentProviderHandle;
        try {
            provider = this.#registry.require(options.provider);
            this.#startingProviders.set(agentId, provider.id);
            handle = await provider.start({
                agentId,
                processes: this.#processes,
                runtime: new AgentProviderRuntimePaths({
                    provider: provider.id,
                    rootDirectory: this.#runtimeRootDirectory,
                    version: provider.version,
                }),
                target: options.target,
                tools: options.tools,
                web: { basePath: `${this.#webBasePath}/` },
            });
        } catch (error) {
            this.#startingProviders.delete(agentId);
            const cleanup = await settleCleanup(options.tools);
            if (cleanup !== undefined) {
                throw new AggregateError(
                    [error, cleanup],
                    `Agent ${agentId} failed to start and release its tool session.`,
                );
            }
            throw error;
        }
        this.#startingProviders.delete(agentId);
        const record: AgentHostRecord = {
            agentId,
            provider: provider.id,
            providerVersion: provider.version,
            state: "running",
            target: { ...options.target },
        };
        const runtime: AgentHostRuntime = {
            handle,
            record,
            tools: options.tools,
        };
        this.#runtimes.set(agentId, runtime);
        void handle.closed
            .then(async () => {
                if (this.#runtimes.get(agentId) !== runtime) return;
                runtime.providerStopped = true;
                if (runtime.cleanup !== undefined) return;
                await this.#stopRuntime(agentId, runtime);
            })
            .catch(reportBackgroundError);
        void options.tools.closed
            .then(async () => {
                if (this.#runtimes.get(agentId) !== runtime) return;
                runtime.toolsClosed = true;
                if (runtime.cleanup !== undefined) return;
                await this.#stopRuntime(agentId, runtime);
            })
            .catch(reportBackgroundError);
        return cloneRecord(record);
    }

    async stop(agentId: string): Promise<AgentHostRecord> {
        const runtime = this.#runtimes.get(agentId);
        if (runtime === undefined) {
            throw new Error(`Unknown Agent: ${agentId}`);
        }
        return await this.#stopRuntime(agentId, runtime);
    }

    async stopAll(): Promise<void> {
        const failures: unknown[] = [];
        for (const agentId of [...this.#runtimes.keys()]) {
            if (!this.#runtimes.has(agentId)) continue;
            await this.stop(agentId).catch((error) => failures.push(error));
        }
        const web = this.#web;
        if (web !== undefined) {
            await web.handle.stop().then(
                () => {
                    if (this.#web === web) this.#web = undefined;
                },
                (error) => failures.push(error),
            );
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "One or more Agent resources failed to stop cleanly.",
            );
        }
    }

    async #stopRuntime(
        agentId: string,
        runtime: AgentHostRuntime,
    ): Promise<AgentHostRecord> {
        if (runtime.cleanup !== undefined) return await runtime.cleanup;
        const cleanup = (async () => {
            runtime.record.state = "stopping";
            const failures: unknown[] = [];
            if (runtime.providerStopped !== true) {
                try {
                    await runtime.handle.stop();
                    runtime.providerStopped = true;
                } catch (error) {
                    failures.push(error);
                }
            }
            if (runtime.toolsClosed !== true) {
                try {
                    await runtime.tools.close();
                    runtime.toolsClosed = true;
                } catch (error) {
                    failures.push(error);
                }
            }
            if (failures.length === 1) throw failures[0];
            if (failures.length > 1) {
                throw new AggregateError(
                    failures,
                    `Agent ${agentId} failed to stop cleanly.`,
                );
            }
            runtime.record.state = "stopped";
            const stopped = cloneRecord(runtime.record);
            if (this.#runtimes.get(agentId) === runtime) {
                this.#runtimes.delete(agentId);
            }
            return stopped;
        })();
        runtime.cleanup = cleanup;
        try {
            return await cleanup;
        } finally {
            if (runtime.cleanup === cleanup) runtime.cleanup = undefined;
        }
    }

    #requireRuntime(agentId: string): AgentHostRuntime {
        const runtime = this.#runtimes.get(agentId);
        if (runtime === undefined) {
            throw new Error(`Unknown Agent: ${agentId}`);
        }
        return runtime;
    }

    #formatWebEndpoint(upstream: URL): AgentHostWebEndpoint {
        return {
            basePath: `${this.#webBasePath}/`,
            upstream: upstream.toString(),
        };
    }
}

function normalizeBasePath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) {
        throw new TypeError("Agent web base path must start with '/'.");
    }
    return trimmed === "/" ? "" : trimmed.replace(/\/+$/u, "");
}

function cloneRecord(record: AgentHostRecord): AgentHostRecord {
    return {
        ...record,
        target: { ...record.target },
    };
}

async function settleCleanup(
    session: AgentToolSession,
): Promise<unknown | undefined> {
    try {
        await session.close();
        return undefined;
    } catch (error) {
        return error;
    }
}

function reportBackgroundError(error: unknown): void {
    console.warn(error instanceof Error ? error : new Error(String(error)));
}

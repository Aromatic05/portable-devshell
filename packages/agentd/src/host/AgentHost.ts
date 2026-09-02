import { randomUUID } from "node:crypto";

import type {
    AgentProvider,
    AgentProviderHandle,
    AgentWorkerClient
} from "../provider/AgentProvider.js";
import { AgentProviderRuntimePaths } from "../runtime/AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";
import { AgentProviderRegistry } from "./AgentProviderRegistry.js";

export type AgentHostState = "starting" | "running" | "stopping" | "stopped";

export interface AgentHostRecord {
    agentId: string;
    provider: string;
    providerVersion: string;
    slug: string;
    state: AgentHostState;
    target: AgentWorkerTarget;
    web?: {
        basePath: string;
        upstream: string;
    };
}

export interface AgentHostStartOptions {
    provider: string;
    slug?: string;
    target: AgentWorkerTarget;
}

export type AgentHostWorkerFactory = (
    target: AgentWorkerTarget,
    agentId: string
) => AgentWorkerClient | Promise<AgentWorkerClient>;

export interface AgentHostOptions {
    homeDirectory?: string;
    idFactory?: () => string;
    providers?: readonly AgentProvider[];
    registry?: AgentProviderRegistry;
    slugFactory?: (agentId: string) => string;
    webBasePath?: string;
    workerFactory: AgentHostWorkerFactory;
}

interface AgentHostRuntime {
    handle: AgentProviderHandle;
    record: AgentHostRecord;
    worker: AgentWorkerClient;
}

export class AgentHost {
    readonly #homeDirectory?: string;
    readonly #idFactory: () => string;
    readonly #registry: AgentProviderRegistry;
    readonly #runtimes = new Map<string, AgentHostRuntime>();
    readonly #slugFactory: (agentId: string) => string;
    readonly #webBasePath: string;
    readonly #workerFactory: AgentHostWorkerFactory;

    constructor(options: AgentHostOptions) {
        this.#homeDirectory = options.homeDirectory;
        this.#idFactory = options.idFactory ?? (() => `ag-${randomUUID()}`);
        this.#registry = options.registry ?? new AgentProviderRegistry(options.providers);
        this.#slugFactory = options.slugFactory ?? defaultSlug;
        this.#webBasePath = normalizeBasePath(options.webBasePath ?? "/agent");
        this.#workerFactory = options.workerFactory;
    }

    get registry(): AgentProviderRegistry {
        return this.#registry;
    }

    list(): AgentHostRecord[] {
        return [...this.#runtimes.values()].map((runtime) => cloneRecord(runtime.record));
    }

    get(agentId: string): AgentHostRecord | undefined {
        const runtime = this.#runtimes.get(agentId);
        return runtime === undefined ? undefined : cloneRecord(runtime.record);
    }

    async prompt(agentId: string, message: string): Promise<void> {
        await this.#requireRuntime(agentId).handle.prompt(message);
    }

    async steer(agentId: string, message: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.steer === undefined) {
            throw new Error(`Agent provider ${runtime.record.provider} does not support steering.`);
        }
        await runtime.handle.steer(message);
    }

    async followUp(agentId: string, message: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.followUp === undefined) {
            throw new Error(`Agent provider ${runtime.record.provider} does not support follow-up messages.`);
        }
        await runtime.handle.followUp(message);
    }

    async abort(agentId: string): Promise<void> {
        const runtime = this.#requireRuntime(agentId);
        if (runtime.handle.abort === undefined) {
            throw new Error(`Agent provider ${runtime.record.provider} does not support abort.`);
        }
        await runtime.handle.abort();
    }

    async start(options: AgentHostStartOptions): Promise<AgentHostRecord> {
        const provider = this.#registry.require(options.provider);
        const agentId = this.#idFactory();
        if (this.#runtimes.has(agentId)) {
            throw new Error(`Agent id already exists: ${agentId}`);
        }
        const slug = options.slug ?? this.#slugFactory(agentId);
        assertSlug(slug);
        if ([...this.#runtimes.values()].some((runtime) => runtime.record.slug === slug)) {
            throw new Error(`Agent slug already exists: ${slug}`);
        }

        const basePath = `${this.#webBasePath}/${slug}/`;
        const worker = await this.#workerFactory(options.target, agentId);
        try {
            const handle = await provider.start({
                agentId,
                runtime: new AgentProviderRuntimePaths({
                    homeDirectory: this.#homeDirectory,
                    provider: provider.id,
                    version: provider.version
                }),
                target: options.target,
                web: { basePath },
                worker
            });
            const record: AgentHostRecord = {
                agentId,
                provider: provider.id,
                providerVersion: provider.version,
                slug,
                state: "running",
                target: { ...options.target },
                ...(handle.web === undefined
                    ? {}
                    : {
                        web: {
                            basePath,
                            upstream: handle.web.upstream.toString()
                        }
                    })
            };
            this.#runtimes.set(agentId, { handle, record, worker });
            return cloneRecord(record);
        } catch (error) {
            await worker.close().catch(() => undefined);
            throw error;
        }
    }

    async stop(agentId: string): Promise<AgentHostRecord> {
        const runtime = this.#runtimes.get(agentId);
        if (runtime === undefined) {
            throw new Error(`Unknown Agent: ${agentId}`);
        }
        runtime.record.state = "stopping";
        const failures: unknown[] = [];
        try {
            await runtime.handle.stop();
        } catch (error) {
            failures.push(error);
        }
        try {
            await runtime.worker.close();
        } catch (error) {
            failures.push(error);
        }
        runtime.record.state = "stopped";
        const stopped = cloneRecord(runtime.record);
        this.#runtimes.delete(agentId);
        if (failures.length === 1) {
            throw failures[0];
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, `Agent ${agentId} failed to stop cleanly.`);
        }
        return stopped;
    }

    async stopAll(): Promise<void> {
        const failures: unknown[] = [];
        for (const agentId of [...this.#runtimes.keys()]) {
            await this.stop(agentId).catch((error) => failures.push(error));
        }
        if (failures.length > 0) {
            throw new AggregateError(failures, "One or more Agents failed to stop cleanly.");
        }
    }

    #requireRuntime(agentId: string): AgentHostRuntime {
        const runtime = this.#runtimes.get(agentId);
        if (runtime === undefined) {
            throw new Error(`Unknown Agent: ${agentId}`);
        }
        return runtime;
    }
}

function normalizeBasePath(value: string): string {
    const trimmed = value.trim();
    if (!trimmed.startsWith("/")) {
        throw new TypeError("Agent web base path must start with '/'.");
    }
    return trimmed === "/" ? "" : trimmed.replace(/\/+$/u, "");
}

function defaultSlug(agentId: string): string {
    return `agent-${agentId.replace(/^ag-/u, "").slice(0, 12).toLowerCase()}`;
}

function assertSlug(slug: string): void {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/u.test(slug)) {
        throw new TypeError(`Invalid Agent slug: ${slug}`);
    }
}

function cloneRecord(record: AgentHostRecord): AgentHostRecord {
    return {
        ...record,
        target: { ...record.target },
        ...(record.web === undefined ? {} : { web: { ...record.web } })
    };
}

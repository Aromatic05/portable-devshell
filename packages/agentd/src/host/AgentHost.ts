import { randomUUID } from "node:crypto";

import type {
    AgentProvider,
    AgentProviderHandle
} from "../provider/AgentProvider.js";
import { AgentProviderRuntimePaths } from "../runtime/AgentProviderRuntimePaths.js";
import type { AgentWorkerTarget } from "../target/AgentWorkerTarget.js";
import { AgentProviderRegistry } from "./AgentProviderRegistry.js";

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
}

export interface AgentHostOptions {
    homeDirectory?: string;
    idFactory?: () => string;
    providers?: readonly AgentProvider[];
    registry?: AgentProviderRegistry;
    webBasePath?: string;
}

interface AgentHostRuntime {
    handle: AgentProviderHandle;
    record: AgentHostRecord;
}

export class AgentHost {
    readonly #homeDirectory?: string;
    readonly #idFactory: () => string;
    readonly #registry: AgentProviderRegistry;
    readonly #runtimes = new Map<string, AgentHostRuntime>();
    readonly #webBasePath: string;

    constructor(options: AgentHostOptions) {
        this.#homeDirectory = options.homeDirectory;
        this.#idFactory = options.idFactory ?? (() => `ag-${randomUUID()}`);
        this.#registry = options.registry ?? new AgentProviderRegistry(options.providers);
        this.#webBasePath = normalizeBasePath(options.webBasePath ?? "/agent");
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

    webEndpoint(): AgentHostWebEndpoint | undefined {
        const endpoints = [...this.#runtimes.values()]
            .map((runtime) => runtime.handle.web?.upstream.toString())
            .filter((upstream): upstream is string => upstream !== undefined);
        if (endpoints.length === 0) return undefined;
        const upstream = endpoints[0]!;
        if (endpoints.some((candidate) => candidate !== upstream)) {
            throw new Error("Running Agent providers expose multiple Web endpoints; one /agent hub is required.");
        }
        return {
            basePath: `${this.#webBasePath}/`,
            upstream
        };
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

        const handle = await provider.start({
            agentId,
            runtime: new AgentProviderRuntimePaths({
                homeDirectory: this.#homeDirectory,
                provider: provider.id,
                version: provider.version
            }),
            target: options.target,
            web: { basePath: `${this.#webBasePath}/` }
        });
        const record: AgentHostRecord = {
            agentId,
            provider: provider.id,
            providerVersion: provider.version,
            state: "running",
            target: { ...options.target }
        };
        this.#runtimes.set(agentId, { handle, record });
        return cloneRecord(record);
    }

    async stop(agentId: string): Promise<AgentHostRecord> {
        const runtime = this.#runtimes.get(agentId);
        if (runtime === undefined) {
            throw new Error(`Unknown Agent: ${agentId}`);
        }
        runtime.record.state = "stopping";
        let failure: unknown;
        try {
            await runtime.handle.stop();
        } catch (error) {
            failure = error;
        }
        runtime.record.state = "stopped";
        const stopped = cloneRecord(runtime.record);
        this.#runtimes.delete(agentId);
        if (failure !== undefined) throw failure;
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

function cloneRecord(record: AgentHostRecord): AgentHostRecord {
    return {
        ...record,
        target: { ...record.target }
    };
}

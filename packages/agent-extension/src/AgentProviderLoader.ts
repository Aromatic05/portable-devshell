import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    AGENT_PROVIDER_API_VERSION,
    parseAgentProviderManifest,
    type AgentProvider,
    type AgentProviderManifest,
    type AgentProviderModule
} from "@portable-devshell/agentd";
import type { ExtensionContext } from "@portable-devshell/extension";

import {
    AgentProviderRegistryStore,
    assertProviderSegment
} from "./AgentProviderRegistryStore.js";

export interface LoadedAgentProvider {
    generation: string;
    manifest: AgentProviderManifest;
    provider: AgentProvider;
}

export class AgentProviderLoader {
    readonly #context: ExtensionContext;
    readonly #importer: (url: string) => Promise<unknown>;
    readonly #registry: AgentProviderRegistryStore;

    constructor(
        context: ExtensionContext,
        importer: (url: string) => Promise<unknown> = async (url) => await import(url) as unknown,
        registry = new AgentProviderRegistryStore(join(context.paths.stateDirectory, "providers.json"))
    ) {
        this.#context = context;
        this.#importer = importer;
        this.#registry = registry;
    }

    async loadSelected(): Promise<AgentProvider[]> {
        const registry = await this.#registry.read();
        const providers: AgentProvider[] = [];
        for (const [id, entry] of Object.entries(registry.providers).sort(([left], [right]) => left.localeCompare(right))) {
            if (!entry.enabled) continue;
            const candidates = [...new Set([
                entry.selectedGeneration,
                entry.lastKnownGoodGeneration
            ].filter((generation): generation is string => generation !== undefined))];
            let loaded: LoadedAgentProvider | undefined;
            let lastFailure: unknown;
            for (const generation of candidates) {
                try {
                    loaded = await this.loadGeneration(id, generation);
                    break;
                } catch (error) {
                    lastFailure = error;
                    this.#context.logger.warn(`Agent provider ${id} generation ${generation} failed to load.`, {
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
            }
            if (loaded !== undefined) providers.push(loaded.provider);
            else if (candidates.length > 0) {
                this.#context.logger.error(`Agent provider ${id} has no loadable generation.`, {
                    error: lastFailure instanceof Error ? lastFailure.message : String(lastFailure)
                });
            }
        }
        return providers;
    }

    async inspectGeneration(id: string, generation: string): Promise<AgentProviderManifest> {
        assertProviderSegment(id, "id");
        const manifest = await this.inspectBundle(generation);
        if (manifest.id !== id) {
            throw new Error(`Agent provider generation ${generation} declares id ${manifest.id}, expected ${id}.`);
        }
        return manifest;
    }

    async inspectBundle(generation: string): Promise<AgentProviderManifest> {
        assertProviderSegment(generation, "generation");
        const generationDirectory = this.generationDirectory(generation);
        await assertPlainDirectory(generationDirectory, `Agent provider generation ${generation}`);
        const manifestPath = join(generationDirectory, "devshell-agent-provider.json");
        await assertPlainFile(manifestPath, `Agent provider manifest ${generation}`);
        const manifest = parseAgentProviderManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
        if (manifest.apiVersion !== AGENT_PROVIDER_API_VERSION) {
            throw new Error(
                `Agent provider ${manifest.id} requires API version ${manifest.apiVersion}, but Agent Extension supports ${AGENT_PROVIDER_API_VERSION}.`
            );
        }
        return manifest;
    }

    async loadGeneration(id: string, generation: string): Promise<LoadedAgentProvider> {
        const manifest = await this.inspectGeneration(id, generation);
        const generationDirectory = this.generationDirectory(generation);
        const entryPath = resolveContainedPath(generationDirectory, manifest.entry);
        await assertPlainFile(entryPath, `Agent provider entry ${id}/${generation}`);
        const module = readProviderModule(await this.#importer(pathToFileURL(entryPath).href), id);
        const provider = await module.createAgentProvider();
        if (provider.id !== manifest.id) {
            throw new Error(`Agent provider module returned id ${provider.id}, expected ${manifest.id}.`);
        }
        if (provider.version !== manifest.version) {
            throw new Error(
                `Agent provider ${id} runtime version ${provider.version} does not match manifest ${manifest.version}.`
            );
        }
        return { generation, manifest, provider };
    }

    generationDirectory(generation: string): string {
        assertProviderSegment(generation, "generation");
        return join(this.#context.paths.dataDirectory, "bundles", generation);
    }
}

function readProviderModule(value: unknown, id: string): AgentProviderModule {
    if (!isRecord(value) || typeof value.createAgentProvider !== "function") {
        throw new TypeError(`Agent provider ${id} entry must export createAgentProvider().`);
    }
    return value as unknown as AgentProviderModule;
}

function resolveContainedPath(root: string, candidate: string): string {
    if (isAbsolute(candidate)) throw new TypeError("Agent provider entry must be relative to its generation.");
    const resolved = resolve(root, candidate);
    const child = relative(root, resolved);
    if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return resolved;
    throw new TypeError("Agent provider entry must stay inside its generation.");
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError(`${label} must be a plain directory.`);
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TypeError(`${label} must be a plain file.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

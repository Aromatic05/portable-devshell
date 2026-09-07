import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
    AGENT_PROVIDER_API_VERSION,
    parseAgentProviderManifest,
    type AgentProvider,
    type AgentProviderModule
} from "@portable-devshell/agentd";
import type { ExtensionContext } from "@portable-devshell/extension";

interface AgentProviderRegistryEntry {
    enabled: boolean;
    generation: string;
}

interface AgentProviderRegistrySnapshot {
    providers: Record<string, AgentProviderRegistryEntry>;
    schemaVersion: 1;
}

export class AgentProviderLoader {
    readonly #context: ExtensionContext;
    readonly #importer: (url: string) => Promise<unknown>;

    constructor(
        context: ExtensionContext,
        importer: (url: string) => Promise<unknown> = async (url) => await import(url) as unknown
    ) {
        this.#context = context;
        this.#importer = importer;
    }

    async loadSelected(): Promise<AgentProvider[]> {
        const registry = await readProviderRegistry(join(this.#context.paths.stateDirectory, "providers.json"));
        const providers: AgentProvider[] = [];
        for (const [id, entry] of Object.entries(registry.providers).sort(([left], [right]) => left.localeCompare(right))) {
            if (!entry.enabled) continue;
            providers.push(await this.#loadGeneration(id, entry.generation));
        }
        return providers;
    }

    async #loadGeneration(id: string, generation: string): Promise<AgentProvider> {
        assertSafeSegment(id, "id");
        assertSafeSegment(generation, "generation");
        const generationDirectory = join(this.#context.paths.dataDirectory, "providers", id, generation);
        await assertPlainDirectory(generationDirectory, `Agent provider generation ${id}/${generation}`);
        const manifestPath = join(generationDirectory, "devshell-agent-provider.json");
        await assertPlainFile(manifestPath, `Agent provider manifest ${id}/${generation}`);
        const manifest = parseAgentProviderManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
        if (manifest.id !== id) {
            throw new Error(`Agent provider generation ${generation} declares id ${manifest.id}, expected ${id}.`);
        }
        if (manifest.apiVersion !== AGENT_PROVIDER_API_VERSION) {
            throw new Error(
                `Agent provider ${id} requires API version ${manifest.apiVersion}, but Agent Extension supports ${AGENT_PROVIDER_API_VERSION}.`
            );
        }
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
        return provider;
    }
}

async function readProviderRegistry(path: string): Promise<AgentProviderRegistrySnapshot> {
    const source = await readFile(path, "utf8").catch((error: unknown) => {
        if (isMissing(error)) return undefined;
        throw error;
    });
    if (source === undefined) return { providers: {}, schemaVersion: 1 };
    const value = JSON.parse(source) as unknown;
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.providers)) {
        throw new TypeError("Agent provider registry is invalid.");
    }
    const providers: Record<string, AgentProviderRegistryEntry> = {};
    for (const [id, raw] of Object.entries(value.providers)) {
        assertSafeSegment(id, "id");
        if (!isRecord(raw) || typeof raw.enabled !== "boolean" || typeof raw.generation !== "string") {
            throw new TypeError(`Agent provider registry entry is invalid: ${id}.`);
        }
        assertSafeSegment(raw.generation, "generation");
        providers[id] = { enabled: raw.enabled, generation: raw.generation };
    }
    return { providers, schemaVersion: 1 };
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

function assertSafeSegment(value: string, label: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
        throw new TypeError(`Invalid Agent provider ${label}: ${value}`);
    }
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) throw new TypeError(`${label} must be a plain directory.`);
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) throw new TypeError(`${label} must be a plain file.`);
}

function isMissing(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

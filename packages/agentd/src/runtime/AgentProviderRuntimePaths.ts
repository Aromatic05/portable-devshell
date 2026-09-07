import { join } from "node:path";

export interface AgentProviderRuntimePathsOptions {
    provider: string;
    rootDirectory: string;
    version: string;
}

/**
 * Filesystem namespace owned by one Agent provider.
 *
 * Executable dependencies live in a versioned prefix while provider-owned
 * session/config state stays outside that prefix. Upgrading a provider can
 * therefore replace its runtime without migrating or deleting its sessions.
 */
export class AgentProviderRuntimePaths {
    readonly agentdDirectory: string;
    readonly cacheDirectory: string;
    readonly prefixDirectory: string;
    readonly providerDirectory: string;
    readonly stateDirectory: string;

    constructor(options: AgentProviderRuntimePathsOptions) {
        assertPathSegment(options.provider, "provider");
        assertPathSegment(options.version, "version");

        if (options.rootDirectory.length === 0) {
            throw new TypeError("Agent provider runtime root must not be empty.");
        }
        this.agentdDirectory = options.rootDirectory;
        this.providerDirectory = join(this.agentdDirectory, "providers", options.provider);
        this.prefixDirectory = join(this.providerDirectory, "prefix", options.version);
        this.stateDirectory = join(this.providerDirectory, "state");
        this.cacheDirectory = join(this.providerDirectory, "cache");
    }
}

function assertPathSegment(value: string, label: string): void {
    if (
        value.length === 0 ||
        value === "." ||
        value === ".." ||
        value.includes("/") ||
        value.includes("\\")
    ) {
        throw new TypeError(`Agent provider ${label} must be one path segment.`);
    }
}

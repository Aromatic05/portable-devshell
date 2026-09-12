import { join } from "node:path";

export interface AgentProviderRuntimePathsOptions {
    provider: string;
    rootDirectory: string;
    version: string;
}

/**
 * Filesystem namespace owned by one Agent provider.
 *
 * Provider-owned executable dependencies live in a versioned prefix. A stable
 * installation directory is reserved for runtimes bootstrapped by the provider
 * but subsequently owned by the runtime itself (for example, self-updating
 * Agent CLIs). Session/config state is stable as well.
 */
export class AgentProviderRuntimePaths {
    readonly agentDirectory: string;
    readonly cacheDirectory: string;
    readonly installationDirectory: string;
    readonly prefixDirectory: string;
    readonly providerDirectory: string;
    readonly stateDirectory: string;

    constructor(options: AgentProviderRuntimePathsOptions) {
        assertPathSegment(options.provider, "provider");
        assertPathSegment(options.version, "version");

        if (options.rootDirectory.length === 0) {
            throw new TypeError("Agent provider runtime root must not be empty.");
        }
        this.agentDirectory = options.rootDirectory;
        this.providerDirectory = join(this.agentDirectory, "providers", options.provider);
        this.prefixDirectory = join(this.providerDirectory, "prefix", options.version);
        this.installationDirectory = join(this.providerDirectory, "install");
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

import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentProviderRuntimePaths } from "../../builtin/provider/AgentProviderRuntimePaths.js";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";

export interface PiProviderInstallation {
    entrypoint: string;
    packageRoot: string;
    version: string;
}

export type PiProviderPackageResolver = (packageName: string) => string | Promise<string>;

export interface PiProviderInstallerOptions {
    packageName?: string;
    resolver?: PiProviderPackageResolver;
    version: string;
}

/**
 * Resolves the Pi runtime bundled in portable-devshell's own dependency graph.
 *
 * Pi is shipped as an exact Agent provider asset dependency, so runtime startup
 * never depends on a host npm/pnpm installation or the user's global Pi setup.
 * Provider state remains under AgentProviderRuntimePaths; executable code is
 * immutable application content managed by portable-devshell releases.
 */
export class PiProviderInstaller {
    readonly #packageName: string;
    readonly #resolver: PiProviderPackageResolver;
    readonly #version: string;
    #resolved?: Promise<PiProviderInstallation>;

    constructor(options: PiProviderInstallerOptions) {
        this.#packageName = options.packageName ?? PI_PACKAGE_NAME;
        this.#resolver = options.resolver ?? resolveBundledPackage;
        this.#version = options.version;
    }

    async ensureInstalled(_runtime: AgentProviderRuntimePaths): Promise<PiProviderInstallation> {
        if (this.#resolved !== undefined) return await this.#resolved;
        const resolving = this.#resolveInstallation().finally(() => {
            if (this.#resolved === resolving) this.#resolved = undefined;
        });
        this.#resolved = resolving;
        const installation = await resolving;
        this.#resolved = Promise.resolve(installation);
        return installation;
    }

    async #resolveInstallation(): Promise<PiProviderInstallation> {
        const resolved = await this.#resolver(this.#packageName);
        const entrypoint = toFilesystemPath(resolved);
        const packageRoot = await findPackageRoot(entrypoint, this.#packageName);
        const manifest = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8")) as {
            version?: unknown;
        };
        if (manifest.version !== this.#version) {
            throw new Error(
                `Bundled Pi provider version mismatch: expected ${this.#packageName}@${this.#version}, `
                + `found ${String(manifest.version)}.`
            );
        }
        return { entrypoint, packageRoot, version: this.#version };
    }
}

async function resolveBundledPackage(packageName: string): Promise<string> {
    return import.meta.resolve(packageName);
}

function toFilesystemPath(value: string): string {
    return value.startsWith("file:") ? fileURLToPath(value) : resolve(value);
}

async function findPackageRoot(entrypoint: string, packageName: string): Promise<string> {
    const filesystemRoot = parse(entrypoint).root;
    let directory = dirname(entrypoint);
    while (directory !== filesystemRoot) {
        try {
            const manifest = JSON.parse(await readFile(resolve(directory, "package.json"), "utf8")) as {
                name?: unknown;
            };
            if (manifest.name === packageName) return directory;
        } catch (error) {
            if (!isMissingFile(error)) throw error;
        }
        const parent = dirname(directory);
        if (parent === directory) break;
        directory = parent;
    }
    throw new Error(`Unable to locate bundled ${packageName} package root from ${entrypoint}.`);
}

function isMissingFile(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as { code?: unknown }).code === "ENOENT";
}

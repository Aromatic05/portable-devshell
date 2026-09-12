import { createRequire } from "node:module";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentProviderRuntimePaths } from "../../builtin/provider/AgentProviderRuntimePaths.js";

export const OPENCODE_PACKAGE_NAME = "opencode-ai";
export const OPENCODE_RUNTIME_VERSION = "1.18.30";

export interface OpenCodeProviderInstallation {
    command: string;
    version: string;
}

export type OpenCodePackageResolver = (specifier: string) => string | Promise<string>;

export interface OpenCodeProviderInstallerOptions {
    packageName?: string;
    resolver?: OpenCodePackageResolver;
    version: string;
}

/** Resolve the OpenCode executable from the Provider's dependency graph only. */
export class OpenCodeProviderInstaller {
    readonly #packageName: string;
    readonly #resolver: OpenCodePackageResolver;
    readonly #version: string;
    #resolved?: Promise<OpenCodeProviderInstallation>;

    constructor(options: OpenCodeProviderInstallerOptions) {
        this.#packageName = options.packageName ?? OPENCODE_PACKAGE_NAME;
        this.#resolver = options.resolver ?? resolveBundledPackage;
        this.#version = options.version;
    }

    async ensureInstalled(_runtime: AgentProviderRuntimePaths): Promise<OpenCodeProviderInstallation> {
        if (this.#resolved !== undefined) return await this.#resolved;
        const resolving = this.#resolveInstallation().finally(() => {
            if (this.#resolved === resolving) this.#resolved = undefined;
        });
        this.#resolved = resolving;
        const installation = await resolving;
        this.#resolved = Promise.resolve(installation);
        return installation;
    }

    async #resolveInstallation(): Promise<OpenCodeProviderInstallation> {
        const manifestPath = toFilesystemPath(await this.#resolver(`${this.#packageName}/package.json`));
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            bin?: string | Record<string, string>;
            name?: unknown;
            optionalDependencies?: Record<string, string>;
            version?: unknown;
        };
        if (manifest.name !== this.#packageName || manifest.version !== this.#version) {
            throw new Error(
                `Bundled OpenCode version mismatch: expected ${this.#packageName}@${this.#version}, `
                + `found ${String(manifest.name)}@${String(manifest.version)}.`
            );
        }

        const optionalDependencies = manifest.optionalDependencies ?? {};
        if (Object.keys(optionalDependencies).some((name) => name.startsWith("opencode-"))) {
            const requireFromPackage = createRequire(manifestPath);
            for (const candidate of platformPackageCandidates()) {
                if (optionalDependencies[candidate] !== this.#version) continue;
                let candidateManifest: string;
                try {
                    candidateManifest = requireFromPackage.resolve(`${candidate}/package.json`);
                } catch {
                    continue;
                }
                const candidatePackage = JSON.parse(await readFile(candidateManifest, "utf8")) as {
                    name?: unknown;
                    version?: unknown;
                };
                if (candidatePackage.name !== candidate || candidatePackage.version !== this.#version) continue;
                const command = resolve(dirname(candidateManifest), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
                await assertPlainFile(command);
                return { command, version: this.#version };
            }
            throw new Error(`Bundled OpenCode does not contain a compatible private runtime for ${process.platform}/${process.arch}.`);
        }

        const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.opencode;
        if (typeof bin !== "string" || bin.length === 0) {
            throw new Error("Bundled OpenCode package does not expose an opencode executable.");
        }
        const command = resolve(dirname(manifestPath), bin);
        await assertPlainFile(command);
        return { command, version: this.#version };
    }
}

async function resolveBundledPackage(specifier: string): Promise<string> {
    return createRequire(import.meta.url).resolve(specifier);
}

function toFilesystemPath(value: string): string {
    return value.startsWith("file:") ? fileURLToPath(value) : resolve(value);
}

function platformPackageCandidates(): string[] {
    const platform = process.platform === "win32" ? "windows" : process.platform;
    const base = `opencode-${platform}-${process.arch}`;
    if (process.arch !== "x64") {
        return process.platform === "linux" && isMusl() ? [`${base}-musl`, base] : [base];
    }
    if (process.platform === "linux" && isMusl()) {
        return [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base];
    }
    return [`${base}-baseline`, base];
}

function isMusl(): boolean {
    if (process.platform !== "linux") return false;
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: unknown } } | undefined;
    const header = report?.header;
    return typeof header?.glibcVersionRuntime !== "string";
}

async function assertPlainFile(path: string): Promise<void> {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error(`Bundled OpenCode executable is not a plain file: ${path}`);
}

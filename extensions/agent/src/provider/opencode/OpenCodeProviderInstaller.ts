import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentProviderRuntimePaths } from "../../builtin/provider/AgentProviderRuntimePaths.js";

export const OPENCODE_PACKAGE_NAME = "opencode-ai";
export const OPENCODE_RUNTIME_VERSION = "1.18.30";
export const OPENCODE_PROVIDER_RUNTIME_DEPENDENCIES = Object.freeze({
    "@agentclientprotocol/sdk": "1.4.0",
    "@modelcontextprotocol/node": "2.0.0",
    "@modelcontextprotocol/server": "2.0.0",
    "opencode-ai": OPENCODE_RUNTIME_VERSION,
});

export interface OpenCodeProviderInstallation {
    command: string;
    moduleRoot: string;
    version: string;
}

export interface OpenCodeProviderInstallerOptions {
    packageName?: string;
    version: string;
}

/** Resolve OpenCode only from the client-installed Provider prefix. */
export class OpenCodeProviderInstaller {
    readonly #packageName: string;
    readonly #version: string;
    #resolved?: Promise<OpenCodeProviderInstallation>;

    constructor(options: OpenCodeProviderInstallerOptions) {
        this.#packageName = options.packageName ?? OPENCODE_PACKAGE_NAME;
        this.#version = options.version;
    }

    async ensureInstalled(
        runtime: AgentProviderRuntimePaths,
    ): Promise<OpenCodeProviderInstallation> {
        if (this.#resolved !== undefined) return await this.#resolved;
        const resolving = this.#resolveInstallation(runtime).finally(() => {
            if (this.#resolved === resolving) this.#resolved = undefined;
        });
        this.#resolved = resolving;
        const installation = await resolving;
        this.#resolved = Promise.resolve(installation);
        return installation;
    }

    async #resolveInstallation(
        runtime: AgentProviderRuntimePaths,
    ): Promise<OpenCodeProviderInstallation> {
        const packageRoot = join(
            runtime.prefixDirectory,
            "node_modules",
            ...this.#packageName.split("/"),
        );
        const manifestPath = join(packageRoot, "package.json");
        const manifest = JSON.parse(
            await readFile(manifestPath, "utf8").catch((error) => {
                if (isMissing(error)) {
                    throw new Error(
                        "OpenCode Provider runtime is not installed. Run devshell agent provider install opencode first.",
                        { cause: error },
                    );
                }
                throw error;
            }),
        ) as {
            bin?: string | Record<string, string>;
            name?: unknown;
            optionalDependencies?: Record<string, string>;
            version?: unknown;
        };
        if (
            manifest.name !== this.#packageName ||
            manifest.version !== this.#version
        ) {
            throw new Error(
                "Client-installed OpenCode version mismatch: expected " +
                    this.#packageName +
                    "@" +
                    this.#version +
                    ", found " +
                    String(manifest.name) +
                    "@" +
                    String(manifest.version) +
                    ".",
            );
        }

        const optionalDependencies = manifest.optionalDependencies ?? {};
        if (
            Object.keys(optionalDependencies).some((name) =>
                name.startsWith("opencode-"),
            )
        ) {
            for (const candidate of platformPackageCandidates()) {
                if (optionalDependencies[candidate] !== this.#version) continue;
                const candidateManifest = join(
                    runtime.prefixDirectory,
                    "node_modules",
                    ...candidate.split("/"),
                    "package.json",
                );
                let candidatePackage: { name?: unknown; version?: unknown };
                try {
                    candidatePackage = JSON.parse(
                        await readFile(candidateManifest, "utf8"),
                    ) as {
                        name?: unknown;
                        version?: unknown;
                    };
                } catch {
                    continue;
                }
                if (
                    candidatePackage.name !== candidate ||
                    candidatePackage.version !== this.#version
                ) {
                    continue;
                }
                const command = resolve(
                    dirname(candidateManifest),
                    "bin",
                    process.platform === "win32" ? "opencode.exe" : "opencode",
                );
                await assertPlainFile(command);
                return {
                    command,
                    moduleRoot: runtime.prefixDirectory,
                    version: this.#version,
                };
            }
            throw new Error(
                "Client-installed OpenCode does not contain a compatible runtime for " +
                    process.platform +
                    "/" +
                    process.arch +
                    ".",
            );
        }

        const bin =
            typeof manifest.bin === "string"
                ? manifest.bin
                : manifest.bin?.opencode;
        if (typeof bin !== "string" || bin.length === 0) {
            throw new Error(
                "Client-installed OpenCode package does not expose an opencode executable.",
            );
        }
        const command = resolve(packageRoot, bin);
        await assertPlainFile(command);
        return {
            command,
            moduleRoot: runtime.prefixDirectory,
            version: this.#version,
        };
    }
}

function platformPackageCandidates(): string[] {
    const platform =
        process.platform === "win32" ? "windows" : process.platform;
    const base = "opencode-" + platform + "-" + process.arch;
    if (process.arch !== "x64") {
        return process.platform === "linux" && isMusl()
            ? [base + "-musl", base]
            : [base];
    }
    if (process.platform === "linux" && isMusl()) {
        return [
            base + "-baseline-musl",
            base + "-musl",
            base + "-baseline",
            base,
        ];
    }
    return [base + "-baseline", base];
}

function isMusl(): boolean {
    if (process.platform !== "linux") return false;
    const report = process.report?.getReport() as
        { header?: { glibcVersionRuntime?: unknown } } | undefined;
    const header = report?.header;
    return typeof header?.glibcVersionRuntime !== "string";
}

async function assertPlainFile(path: string): Promise<void> {
    const metadata = await stat(path);
    if (!metadata.isFile()) {
        throw new Error(
            "Client-installed OpenCode executable is not a plain file: " + path,
        );
    }
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

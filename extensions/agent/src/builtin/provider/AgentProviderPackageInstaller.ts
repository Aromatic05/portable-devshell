import { randomUUID } from "node:crypto";
import {
    lstat,
    mkdir,
    readFile,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ExtensionProcessCapability } from "@portable-devshell/extension";

import type { AgentProviderRuntimePaths } from "./AgentProviderRuntimePaths.js";

const INSTALL_MARKER = "devshell-agent-runtime.json";
const MAX_DIAGNOSTIC_BYTES = 32 * 1024;

export interface AgentProviderPackageSpec {
    dependencies: Readonly<Record<string, string>>;
    id: string;
    version: string;
}

export interface AgentProviderPackageInstallOptions {
    force?: boolean;
}

/**
 * Installs Provider-owned third-party packages on the client.
 *
 * Provider packages are deliberately outside the Extension generation. This
 * keeps .dsext platform-neutral while letting npm resolve OS/architecture
 * optional dependencies on the machine that will actually execute them.
 */
export class AgentProviderPackageInstaller {
    readonly #processes: ExtensionProcessCapability;

    constructor(processes: ExtensionProcessCapability) {
        this.#processes = processes;
    }

    async isInstalled(
        runtime: AgentProviderRuntimePaths,
        spec: AgentProviderPackageSpec,
    ): Promise<boolean> {
        const marker = await readMarker(runtime.prefixDirectory);
        if (marker === undefined || !markerMatches(marker, spec)) return false;
        try {
            await assertInstalledDependencies(runtime.prefixDirectory, spec);
            return true;
        } catch {
            return false;
        }
    }

    async install(
        runtime: AgentProviderRuntimePaths,
        spec: AgentProviderPackageSpec,
        options: AgentProviderPackageInstallOptions = {},
    ): Promise<void> {
        validateSpec(spec);
        if (
            options.force !== true &&
            (await this.isInstalled(runtime, spec))
        ) {
            return;
        }

        await mkdir(runtime.providerDirectory, {
            mode: 0o700,
            recursive: true,
        });
        const transactionId = randomUUID();
        const staging = join(
            runtime.providerDirectory,
            `.prefix-install-${transactionId}`,
        );
        const backup = join(
            runtime.providerDirectory,
            `.prefix-replaced-${transactionId}`,
        );
        let previousMoved = false;
        try {
            await mkdir(staging, { mode: 0o700 });
            await writeFile(
                join(staging, "package.json"),
                `${JSON.stringify(
                    {
                        dependencies: { ...spec.dependencies },
                        name: `portable-devshell-agent-provider-${spec.id}`,
                        private: true,
                        type: "module",
                        version: "0.0.0",
                    },
                    null,
                    2,
                )}\n`,
                "utf8",
            );
            await this.#npmInstall(staging, spec.id);
            await assertInstalledDependencies(staging, spec);
            await writeFile(
                join(staging, INSTALL_MARKER),
                `${JSON.stringify(markerFor(spec), null, 2)}\n`,
                { mode: 0o600 },
            );

            const existing = await lstat(runtime.prefixDirectory).catch(
                (error: unknown) => {
                    if (isMissing(error)) return undefined;
                    throw error;
                },
            );
            if (existing !== undefined) {
                if (existing.isSymbolicLink() || !existing.isDirectory()) {
                    throw new Error(
                        `Agent provider ${spec.id} prefix is not a plain directory.`,
                    );
                }
                await rename(runtime.prefixDirectory, backup);
                previousMoved = true;
            }
            try {
                await mkdir(dirname(runtime.prefixDirectory), {
                    recursive: true,
                });
                await rename(staging, runtime.prefixDirectory);
            } catch (error) {
                if (previousMoved) {
                    try {
                        await rename(backup, runtime.prefixDirectory);
                        previousMoved = false;
                    } catch (rollbackError) {
                        throw new AggregateError(
                            [error, rollbackError],
                            `Agent provider ${spec.id} installation failed and the previous runtime could not be restored.`,
                        );
                    }
                }
                throw error;
            }
            if (previousMoved) {
                previousMoved = false;
                await rm(backup, { force: true, recursive: true }).catch(
                    () => undefined,
                );
            }
        } finally {
            await rm(staging, { force: true, recursive: true });
            if (previousMoved) {
                await rename(backup, runtime.prefixDirectory);
                previousMoved = false;
            }
            await rm(backup, { force: true, recursive: true });
        }
    }

    async remove(runtime: AgentProviderRuntimePaths): Promise<void> {
        await rm(runtime.prefixDirectory, { force: true, recursive: true });
    }

    async #npmInstall(directory: string, providerId: string): Promise<void> {
        const child = await this.#processes.start({
            args: [
                "install",
                "--ignore-scripts",
                "--omit=dev",
                "--no-audit",
                "--no-fund",
                "--package-lock=false",
            ],
            command: process.platform === "win32" ? "npm.cmd" : "npm",
            cwd: directory,
            environment: {
                NO_UPDATE_NOTIFIER: "1",
                npm_config_update_notifier: "false",
            },
        });
        let stderr = "";
        let stdout = "";
        child.onStderr((chunk) => {
            stderr = tailDiagnostic(stderr, chunk);
        });
        child.onStdout((chunk) => {
            stdout = tailDiagnostic(stdout, chunk);
        });
        const exit = await child.closed;
        if (exit.code === 0) return;
        const detail = [stderr.trim(), stdout.trim()]
            .filter((value) => value.length > 0)
            .join("\n");
        throw new Error(
            `Failed to install Agent provider ${providerId} dependencies with npm (exit ${exit.code ?? exit.signal ?? "unknown"}).` +
                (detail.length === 0 ? "" : `\n${detail}`),
        );
    }
}

async function assertInstalledDependencies(
    root: string,
    spec: AgentProviderPackageSpec,
): Promise<void> {
    for (const [name, version] of Object.entries(spec.dependencies)) {
        const manifestPath = join(root, "node_modules", ...name.split("/"), "package.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
            name?: unknown;
            version?: unknown;
        };
        if (manifest.name !== name || manifest.version !== version) {
            throw new Error(
                `Agent provider ${spec.id} dependency mismatch for ${name}: expected ${version}, found ${String(manifest.version)}.`,
            );
        }
    }
}

async function readMarker(root: string): Promise<unknown | undefined> {
    const source = await readFile(join(root, INSTALL_MARKER), "utf8").catch(
        (error: unknown) => {
            if (isMissing(error)) return undefined;
            throw error;
        },
    );
    return source === undefined ? undefined : JSON.parse(source);
}

function markerFor(spec: AgentProviderPackageSpec): Record<string, unknown> {
    return {
        dependencies: { ...spec.dependencies },
        provider: spec.id,
        providerVersion: spec.version,
        schemaVersion: 1,
    };
}

function markerMatches(
    value: unknown,
    spec: AgentProviderPackageSpec,
): boolean {
    if (!isRecord(value)) return false;
    if (
        value.schemaVersion !== 1 ||
        value.provider !== spec.id ||
        value.providerVersion !== spec.version ||
        !isRecord(value.dependencies)
    ) {
        return false;
    }
    const expected = Object.entries(spec.dependencies).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    const actual = Object.entries(value.dependencies).sort(([left], [right]) =>
        left.localeCompare(right),
    );
    return (
        expected.length === actual.length &&
        expected.every(
            ([name, version], index) =>
                actual[index]?.[0] === name && actual[index]?.[1] === version,
        )
    );
}

function validateSpec(spec: AgentProviderPackageSpec): void {
    if (!/^[a-z0-9][a-z0-9._-]*$/u.test(spec.id)) {
        throw new TypeError(`Invalid Agent provider id: ${spec.id}`);
    }
    if (spec.version.length === 0) {
        throw new TypeError("Agent provider version must not be empty.");
    }
    for (const [name, version] of Object.entries(spec.dependencies)) {
        if (name.length === 0 || version.length === 0) {
            throw new TypeError(
                "Agent provider dependencies must use non-empty package names and exact versions.",
            );
        }
    }
}

function tailDiagnostic(current: string, chunk: string): string {
    return `${current}${chunk}`.slice(-MAX_DIAGNOSTIC_BYTES);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
    );
}

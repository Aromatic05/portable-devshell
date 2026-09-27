import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { AgentProviderRuntimePaths } from "../../builtin/provider/AgentProviderRuntimePaths.js";

export const PI_PACKAGE_NAME = "@earendil-works/pi-coding-agent";
export const PI_BOOTSTRAP_VERSION = "0.85.1";
export const PI_PROVIDER_RUNTIME_DEPENDENCIES = Object.freeze({
    "@earendil-works/pi-coding-agent": PI_BOOTSTRAP_VERSION,
    "@earendil-works/pi-tui": "0.85.1",
    diff: "9.0.0",
    "pi-gui-extension": "0.4.1",
    typebox: "1.3.30",
});

const MANAGED_INSTALL_MARKER = "managed-install.json";
const MANAGED_INSTALL_KIND = "pi-managed-install";
const MANAGED_INSTALL_LAYOUT = "releases-v1";

export interface PiProviderInstallation {
    agentDirectory: string;
    entrypoint: string;
    managedInstallRoot: string;
    moduleRoot: string;
    packageRoot: string;
    version: string;
}

export interface PiProviderInstallerOptions {
    packageName?: string;
    version: string;
}

/**
 * Bootstraps Pi from the client-installed Provider prefix into Pi's stable,
 * self-owned managed installation. Subsequent Pi updates remain independent of
 * the Agent Provider adapter version.
 */
export class PiProviderInstaller {
    readonly #packageName: string;
    readonly #bootstrapVersion: string;
    #resolved?: Promise<PiProviderInstallation>;

    constructor(options: PiProviderInstallerOptions) {
        this.#packageName = options.packageName ?? PI_PACKAGE_NAME;
        this.#bootstrapVersion = options.version;
    }

    async ensureInstalled(
        runtime: AgentProviderRuntimePaths,
    ): Promise<PiProviderInstallation> {
        if (this.#resolved !== undefined) return await this.#resolved;
        const resolving = this.#ensureInstallation(runtime).finally(() => {
            if (this.#resolved === resolving) this.#resolved = undefined;
        });
        this.#resolved = resolving;
        const installation = await resolving;
        this.#resolved = Promise.resolve(installation);
        return installation;
    }

    async #ensureInstallation(
        runtime: AgentProviderRuntimePaths,
    ): Promise<PiProviderInstallation> {
        const existing = await resolveManagedInstallation(
            runtime.installationDirectory,
            runtime.stateDirectory,
            this.#packageName,
        );
        if (existing !== undefined) return existing;

        const seedRoot = runtime.prefixDirectory;
        const seedPackageRoot = join(
            seedRoot,
            "node_modules",
            ...this.#packageName.split("/"),
        );
        const seedManifest = await readPackageManifest(seedPackageRoot).catch(
            (error) => {
                if (isMissingFile(error)) {
                    throw new Error(
                        "Pi Provider runtime is not installed. Run devshell agent provider install pi first.",
                        { cause: error },
                    );
                }
                throw error;
            },
        );
        if (
            seedManifest.name !== this.#packageName ||
            seedManifest.version !== this.#bootstrapVersion
        ) {
            throw new Error(
                "Client-installed Pi bootstrap version mismatch: expected " +
                    this.#packageName +
                    "@" +
                    this.#bootstrapVersion +
                    ", found " +
                    String(seedManifest.name) +
                    "@" +
                    String(seedManifest.version) +
                    ".",
            );
        }

        await mkdir(runtime.providerDirectory, { recursive: true });
        const stagingRoot = join(
            runtime.providerDirectory,
            ".install-bootstrap-" + process.pid + "-" + Date.now(),
        );
        const releaseRoot = join(
            stagingRoot,
            "releases",
            this.#bootstrapVersion,
        );
        try {
            await mkdir(dirname(releaseRoot), { recursive: true });
            await cp(seedRoot, releaseRoot, {
                dereference: true,
                recursive: true,
            });
            await writeFile(
                join(stagingRoot, MANAGED_INSTALL_MARKER),
                JSON.stringify(
                    {
                        kind: MANAGED_INSTALL_KIND,
                        layout: MANAGED_INSTALL_LAYOUT,
                        schemaVersion: 1,
                    },
                    null,
                    4,
                ) + "\n",
                { mode: 0o600 },
            );
            await writeFile(
                join(stagingRoot, "current-version"),
                this.#bootstrapVersion + "\n",
                { mode: 0o600 },
            );
            await writeFile(join(stagingRoot, "update"), "", { mode: 0o600 });
            try {
                await rename(stagingRoot, runtime.installationDirectory);
            } catch (error) {
                if (!isExistingPath(error)) throw error;
            }
        } finally {
            await rm(stagingRoot, { force: true, recursive: true });
        }

        const installed = await resolveManagedInstallation(
            runtime.installationDirectory,
            runtime.stateDirectory,
            this.#packageName,
        );
        if (installed === undefined) {
            throw new Error(
                "Pi bootstrap did not produce a readable managed installation.",
            );
        }
        return installed;
    }
}

export async function hasManagedPiInstallation(
    runtime: AgentProviderRuntimePaths,
): Promise<boolean> {
    return (
        (await resolveManagedInstallation(
            runtime.installationDirectory,
            runtime.stateDirectory,
            PI_PACKAGE_NAME,
        ).catch(() => undefined)) !== undefined
    );
}

export async function removeManagedPiInstallation(
    runtime: AgentProviderRuntimePaths,
): Promise<void> {
    await rm(runtime.installationDirectory, {
        force: true,
        recursive: true,
    });
}

async function resolveManagedInstallation(
    managedInstallRoot: string,
    stateDirectory: string,
    packageName: string,
): Promise<PiProviderInstallation | undefined> {
    const markerSource = await readFile(
        join(managedInstallRoot, MANAGED_INSTALL_MARKER),
        "utf8",
    ).catch((error) => {
        if (isMissingFile(error)) return undefined;
        throw error;
    });
    if (markerSource === undefined) return undefined;
    const marker = JSON.parse(markerSource) as Record<string, unknown>;
    if (
        marker.kind !== MANAGED_INSTALL_KIND ||
        marker.layout !== MANAGED_INSTALL_LAYOUT ||
        marker.schemaVersion !== 1
    ) {
        throw new Error(
            "Pi managed install marker is invalid: " +
                join(managedInstallRoot, MANAGED_INSTALL_MARKER),
        );
    }
    const version = (
        await readFile(join(managedInstallRoot, "current-version"), "utf8")
    ).trim();
    assertReleaseVersion(version);
    const releaseRoot = join(managedInstallRoot, "releases", version);
    const packageRoot = join(
        releaseRoot,
        "node_modules",
        ...packageName.split("/"),
    );
    const manifest = await readPackageManifest(packageRoot);
    if (manifest.name !== packageName || manifest.version !== version) {
        throw new Error(
            "Active Pi release " +
                version +
                " does not match " +
                packageName +
                "@" +
                String(manifest.version) +
                ".",
        );
    }
    const entrypoint = await resolvePackageEntrypoint(packageRoot, manifest);
    return {
        agentDirectory: join(stateDirectory, "pi"),
        entrypoint,
        managedInstallRoot,
        moduleRoot: releaseRoot,
        packageRoot,
        version,
    };
}

async function readPackageManifest(
    packageRoot: string,
): Promise<Record<string, unknown>> {
    return JSON.parse(
        await readFile(join(packageRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
}

async function resolvePackageEntrypoint(
    packageRoot: string,
    manifest: Record<string, unknown>,
): Promise<string> {
    const exportsValue = manifest.exports;
    let relativeEntrypoint: string | undefined;
    if (typeof exportsValue === "string") {
        relativeEntrypoint = exportsValue;
    } else if (typeof exportsValue === "object" && exportsValue !== null) {
        const rootExport = (exportsValue as Record<string, unknown>)["."];
        if (typeof rootExport === "string") relativeEntrypoint = rootExport;
        else if (typeof rootExport === "object" && rootExport !== null) {
            const record = rootExport as Record<string, unknown>;
            relativeEntrypoint =
                typeof record.import === "string"
                    ? record.import
                    : typeof record.default === "string"
                      ? record.default
                      : undefined;
        }
    }
    if (relativeEntrypoint === undefined && typeof manifest.main === "string") {
        relativeEntrypoint = manifest.main;
    }
    const entrypoint = resolve(
        packageRoot,
        relativeEntrypoint ?? "dist/index.js",
    );
    await readFile(entrypoint);
    return entrypoint;
}

function assertReleaseVersion(value: string): void {
    if (
        !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(value)
    ) {
        throw new Error("Invalid active Pi version: " + JSON.stringify(value));
    }
}

function isExistingPath(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        ((error as { code?: unknown }).code === "EEXIST" ||
            (error as { code?: unknown }).code === "ENOTEMPTY")
    );
}

function isMissingFile(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as { code?: unknown }).code === "ENOENT"
    );
}

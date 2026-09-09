import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceLimits } from "node:worker_threads";

import {
    parseExtensionManifest,
    type ExtensionContext,
    type ExtensionAssetCapability,
    type ExtensionJsonValue,
    type ExtensionLogger,
    type ExtensionManifest,
    type ExtensionModule,
    type ExtensionProcessCapability,
    type ExtensionWorkerCapability
} from "@portable-devshell/extension";

import type { InstanceRegistry } from "../../../instance/registry/InstanceRegistry.js";
import { ExtensionAssetCapabilityControl } from "./capability/ExtensionAssetCapabilityControl.js";
import { ExtensionProcessCapabilityControl } from "./capability/ExtensionProcessCapabilityControl.js";
import { ExtensionGeneration } from "./ExtensionGeneration.js";
import { ExtensionRegistrationBuilder } from "./ExtensionRegistration.js";
import { sharedExtensionHostModuleResolver, type ExtensionHostModuleResolver } from "./ExtensionHostModuleResolver.js";
import { ExtensionPathLayout } from "../../state/ExtensionPathLayout.js";
import { ExtensionWorkerCapabilityControl } from "./capability/ExtensionWorkerCapabilityControl.js";
import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions
} from "./sandbox/ExtensionSandboxHost.js";
import type { ExtensionSandboxReadyDescriptor } from "./sandbox/ExtensionSandboxProtocol.js";

export const CORE_EXTENSION_RESERVED_IDS = new Set([
    "approval",
    "artifact",
    "config",
    "context",
    "debug",
    "extension",
    "help",
    "instance",
    "logs",
    "oauth",
    "overview",
    "restart",
    "start",
    "status",
    "stop",
    "todo",
    "tool",
    "tui",
    "version",
    "watch"
]);

export interface ExtensionWorkerRuntime extends ExtensionWorkerCapability {
    closeAll(): Promise<void>;
    retireInstance(instance: string): Promise<void>;
}

export interface ExtensionProcessRuntime extends ExtensionProcessCapability {
    closeAll(): Promise<void>;
}

export interface ExtensionLoaderOptions {
    assetsFactory?: (input: {
        allowed: boolean;
        dataDirectory: string;
        extensionId: string;
        generation: string;
    }) => ExtensionAssetCapability;
    importer?: (url: string) => Promise<unknown>;
    instances: InstanceRegistry;
    hostModuleResolver?: ExtensionHostModuleResolver;
    loggerFactory?: (id: string, generation: string) => ExtensionLogger;
    paths: ExtensionPathLayout;
    processFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionProcessRuntime;
    reservedIds?: ReadonlySet<string>;
    sandboxFactory?: (options: ExtensionSandboxHostOptions) => ExtensionSandboxHost;
    sandboxResourceLimits?: ResourceLimits;
    workerFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionWorkerRuntime;
}

export class ExtensionLoader {
    readonly #assetsFactory?: ExtensionLoaderOptions["assetsFactory"];
    readonly #importer?: (url: string) => Promise<unknown>;
    readonly #hostModuleResolver: ExtensionHostModuleResolver;
    readonly #instances: InstanceRegistry;
    readonly #loggerFactory: (id: string, generation: string) => ExtensionLogger;
    readonly #paths: ExtensionPathLayout;
    readonly #processFactory?: ExtensionLoaderOptions["processFactory"];
    readonly #reservedIds: ReadonlySet<string>;
    readonly #runtimeRoots = new Map<string, Promise<void>>();
    readonly #sandboxFactory: (options: ExtensionSandboxHostOptions) => ExtensionSandboxHost;
    readonly #sandboxResourceLimits?: ResourceLimits;
    readonly #workerFactory?: ExtensionLoaderOptions["workerFactory"];

    constructor(options: ExtensionLoaderOptions) {
        this.#assetsFactory = options.assetsFactory;
        this.#importer = options.importer;
        this.#hostModuleResolver = options.hostModuleResolver ?? sharedExtensionHostModuleResolver();
        this.#instances = options.instances;
        this.#loggerFactory = options.loggerFactory ?? ((id, generation) => consoleExtensionLogger(id, generation));
        this.#paths = options.paths;
        this.#processFactory = options.processFactory;
        this.#reservedIds = options.reservedIds ?? CORE_EXTENSION_RESERVED_IDS;
        this.#sandboxFactory = options.sandboxFactory ?? ((sandboxOptions) => new ExtensionSandboxHost(sandboxOptions));
        this.#sandboxResourceLimits = options.sandboxResourceLimits;
        this.#workerFactory = options.workerFactory;
    }

    async load(id: string, generation: string): Promise<ExtensionGeneration> {
        if (this.#reservedIds.has(id)) {
            throw new Error(`Extension id ${id} is reserved by portable-devshell.`);
        }
        const codeDirectory = this.#paths.generationDirectory(id, generation);
        const dataDirectory = this.#paths.dataDirectory(id);
        const runtimeRoot = this.#paths.runtimeDirectory(id, generation);
        const stateDirectory = this.#paths.stateDirectory(id);
        await assertPlainDirectory(codeDirectory, `Extension generation directory for ${id}`);
        const manifestPath = this.#paths.manifestFile(id, generation);
        await assertPlainFile(manifestPath, `Extension manifest for ${id}`);
        const manifest = parseExtensionManifest(JSON.parse(await readFile(manifestPath, "utf8")) as unknown);
        if (manifest.id !== id) {
            throw new Error(`Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`);
        }
        const entryPath = resolveContainedPath(codeDirectory, manifest.entry, "Extension entry");
        await assertPlainFile(entryPath, `Extension entry for ${id}`);
        await this.#prepareRuntimeRoot(runtimeRoot);
        await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(runtimeRoot, `Extension runtime generation root for ${id}`);
        const runtimeDirectory = join(runtimeRoot, `run-${randomUUID()}`);
        await Promise.all([
            mkdir(dataDirectory, { mode: 0o700, recursive: true }),
            mkdir(runtimeDirectory, { mode: 0o700 }),
            mkdir(stateDirectory, { mode: 0o700, recursive: true })
        ]);

        const assets = this.#assetsFactory?.({
            allowed: manifest.capabilities.includes("assets"),
            dataDirectory,
            extensionId: id,
            generation
        }) ?? new ExtensionAssetCapabilityControl({
            allowed: manifest.capabilities.includes("assets"),
            dataDirectory,
            extensionId: id
        });

        const worker = this.#workerFactory?.({
            allowed: manifest.capabilities.includes("workers"),
            extensionId: id,
            generation
        }) ?? new ExtensionWorkerCapabilityControl({
            allowed: manifest.capabilities.includes("workers"),
            extensionId: id,
            generation,
            instances: this.#instances
        });
        const processes = this.#processFactory?.({
            allowed: manifest.capabilities.includes("processes"),
            extensionId: id,
            generation
        }) ?? new ExtensionProcessCapabilityControl({
            allowed: manifest.capabilities.includes("processes"),
            extensionId: id,
            generation
        });
        const logger = this.#loggerFactory(id, generation);
        const registrations = new ExtensionRegistrationBuilder(manifest, codeDirectory);
        const register: ExtensionContext["register"] = (point, localId, binding) => {
            registrations.register(point, localId, binding);
        };
        const context: ExtensionContext = Object.freeze({
            capabilities: Object.freeze({
                ...(manifest.capabilities.includes("assets") ? { assets } : {}),
                ...(manifest.capabilities.includes("processes") ? { processes } : {}),
                ...(manifest.capabilities.includes("workers") ? { workers: worker } : {})
            }),
            generation,
            id,
            logger,
            paths: Object.freeze({ codeDirectory, dataDirectory, runtimeDirectory, stateDirectory }),
            register,
            version: manifest.version
        });

        if (this.#importer === undefined) {
            return await this.#loadSandboxed({
                assets,
                codeDirectory,
                context,
                entryPath,
                generation,
                id,
                logger,
                manifest,
                processes,
                runtimeRoot,
                runtimeDirectory,
                worker
            });
        }

        const hostModules = this.#hostModuleResolver.register(codeDirectory, manifest.hostDependencies);
        let module: ExtensionModule | undefined;
        try {
            module = readExtensionModule(await this.#importer(pathToFileURL(entryPath).href), id);
            await module.activate(context);
            const bindings = await registrations.finalize();
            return new ExtensionGeneration({
                dispose: async () => await disposeGeneration(
                    module!,
                    processes,
                    worker,
                    runtimeRoot,
                    runtimeDirectory,
                    hostModules.release
                ),
                generation,
                manifest,
                registrations: bindings,
                retireInstanceResources: async (instance) => await worker.retireInstance(instance)
            });
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await Promise.resolve(module?.deactivate?.()).catch((cleanupError: unknown) => cleanupFailures.push(cleanupError));
            await processes.closeAll().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await worker.closeAll().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            try { hostModules.release(); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${id} activation failed and candidate cleanup was incomplete.`
            );
        }
    }

    async #prepareRuntimeRoot(runtimeRoot: string): Promise<void> {
        let preparation = this.#runtimeRoots.get(runtimeRoot);
        if (preparation === undefined) {
            preparation = (async () => {
                await rm(runtimeRoot, { force: true, recursive: true });
                await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
                await assertPlainDirectory(runtimeRoot, "Extension runtime generation root");
            })();
            this.#runtimeRoots.set(runtimeRoot, preparation);
            void preparation.catch(() => this.#runtimeRoots.delete(runtimeRoot));
        }
        await preparation;
    }

    async #loadSandboxed(input: {
        assets: ExtensionAssetCapability;
        codeDirectory: string;
        context: ExtensionContext;
        entryPath: string;
        generation: string;
        id: string;
        logger: ExtensionLogger;
        manifest: ExtensionManifest;
        processes: ExtensionProcessRuntime;
        runtimeRoot: string;
        runtimeDirectory: string;
        worker: ExtensionWorkerRuntime;
    }): Promise<ExtensionGeneration> {
        let candidate: ExtensionGeneration | undefined;
        const sandbox = this.#sandboxFactory({
            assets: input.assets,
            capabilities: input.manifest.capabilities,
            codeDirectory: input.codeDirectory,
            context: {
                generation: input.generation,
                id: input.id,
                paths: input.context.paths,
                version: input.manifest.version
            },
            entryUrl: pathToFileURL(input.entryPath).href,
            hostDependencies: input.manifest.hostDependencies,
            logger: input.logger,
            onFault: (error) => {
                candidate?.fault(error);
                void input.processes.closeAll().catch(() => undefined);
                void input.worker.closeAll().catch(() => undefined);
            },
            processes: input.processes,
            ...(this.#sandboxResourceLimits === undefined ? {} : {
                resourceLimits: this.#sandboxResourceLimits
            }),
            worker: input.worker
        });
        try {
            const descriptor = await sandbox.start();
            const bindings = await registrationsFromSandbox(
                descriptor,
                input.manifest,
                input.codeDirectory,
                sandbox
            );
            candidate = new ExtensionGeneration({
                dispose: async () => await disposeSandboxGeneration(
                    sandbox,
                    input.processes,
                    input.worker,
                    input.runtimeRoot,
                    input.runtimeDirectory
                ),
                generation: input.generation,
                manifest: input.manifest,
                registrations: bindings,
                retireInstanceResources: async (instance) => await input.worker.retireInstance(instance)
            });
            if (sandbox.faultError !== undefined) throw sandbox.faultError;
            return candidate;
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await sandbox.dispose().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await input.processes.closeAll().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await input.worker.closeAll().catch((cleanupError) => cleanupFailures.push(cleanupError));
            await cleanupRuntimeDirectory(input.runtimeRoot, input.runtimeDirectory)
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${input.id} sandbox activation failed and candidate cleanup was incomplete.`
            );
        }
    }
}

async function registrationsFromSandbox(
    descriptor: ExtensionSandboxReadyDescriptor,
    manifest: ExtensionManifest,
    codeDirectory: string,
    sandbox: ExtensionSandboxHost
): Promise<import("./ExtensionRegistration.js").ExtensionRegistrationSet> {
    const registrations = new ExtensionRegistrationBuilder(manifest, codeDirectory);
    for (const registration of descriptor.registrations) {
        switch (registration.runtime.kind) {
            case "cli.command":
                registrations.registerById(
                    registration.pointId,
                    registration.id,
                    async (argv: readonly string[], context: import("@portable-devshell/extension").ExtensionInvocationContext) =>
                        await sandbox.cliCommand(registration.id, argv, context)
                );
                break;
            case "web.files":
                registrations.registerById(registration.pointId, registration.id, Object.freeze({
                    source: Object.freeze({
                        directory: registration.runtime.directory,
                        kind: "files" as const
                    })
                }));
                break;
            case "web.endpoint":
                registrations.registerById(registration.pointId, registration.id, Object.freeze({
                    source: Object.freeze({
                        kind: "endpoint" as const,
                        resolve: async () => await sandbox.webEndpoint(registration.id)
                    })
                }));
                break;
        }
    }
    return await registrations.finalize();
}

function readExtensionModule(value: unknown, id: string): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(`Extension ${id} entry must export an activate(context) function.`);
    }
    if (value.deactivate !== undefined && typeof value.deactivate !== "function") {
        throw new TypeError(`Extension ${id} deactivate export must be a function.`);
    }
    return {
        activate: value.activate as ExtensionModule["activate"],
        ...(value.deactivate === undefined ? {} : { deactivate: value.deactivate as NonNullable<ExtensionModule["deactivate"]> })
    };
}

async function disposeGeneration(
    module: ExtensionModule,
    processes: ExtensionProcessRuntime,
    worker: ExtensionWorkerRuntime,
    runtimeRoot: string,
    runtimeDirectory: string,
    releaseHostModules: () => void
): Promise<void> {
    const failures: unknown[] = [];
    await Promise.resolve(module.deactivate?.()).catch((error) => failures.push(error));
    await processes.closeAll().catch((error) => failures.push(error));
    await worker.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory).catch((error) => failures.push(error));
    try { releaseHostModules(); } catch (error) { failures.push(error); }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Extension generation cleanup failed.");
}

async function disposeSandboxGeneration(
    sandbox: ExtensionSandboxHost,
    processes: ExtensionProcessRuntime,
    worker: ExtensionWorkerRuntime,
    runtimeRoot: string,
    runtimeDirectory: string
): Promise<void> {
    const failures: unknown[] = [];
    await sandbox.dispose().catch((error) => failures.push(error));
    await processes.closeAll().catch((error) => failures.push(error));
    await worker.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory).catch((error) => failures.push(error));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Extension sandbox generation cleanup failed.");
}

async function cleanupRuntimeDirectory(runtimeRoot: string, runtimeDirectory: string): Promise<void> {
    await rm(runtimeDirectory, { force: true, recursive: true });
    await rmdir(runtimeRoot).catch((error: unknown) => {
        if (isMissing(error) || isDirectoryNotEmpty(error)) return;
        throw error;
    });
}

function resolveContainedPath(root: string, candidate: string, label: string): string {
    if (isAbsolute(candidate)) throw new TypeError(`${label} must be relative to the Extension generation.`);
    const resolved = resolve(root, candidate);
    const relativePath = relative(root, resolved);
    if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) return resolved;
    throw new TypeError(`${label} must stay inside the Extension generation.`);
}

async function assertPlainDirectory(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(`${label} must be a real directory, not a symlink.`);
    }
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError(`${label} must be a regular file, not a symlink.`);
    }
}

function isMissing(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isDirectoryNotEmpty(error: unknown): boolean {
    return typeof error === "object"
        && error !== null
        && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOTEMPTY";
}

function consoleExtensionLogger(id: string, generation: string): ExtensionLogger {
    const prefix = `[extension:${id}:${generation}]`;
    const write = (method: "debug" | "error" | "info" | "warn", message: string, details?: ExtensionJsonValue) => {
        if (details === undefined) console[method](`${prefix} ${message}`);
        else console[method](`${prefix} ${message}`, details);
    };
    return {
        debug: (message, details) => write("debug", message, details),
        error: (message, details) => write("error", message, details),
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details)
    };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

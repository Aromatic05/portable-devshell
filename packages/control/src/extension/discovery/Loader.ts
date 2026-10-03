import { randomUUID } from "node:crypto";
import { mkdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceLimits } from "node:worker_threads";

import {
    type ExtensionContext,
    type ExtensionJsonValue,
    type ExtensionLogger,
    type ExtensionManifest,
    type ExtensionModule,
} from "@portable-devshell/extension";
import type { ExtensionAssetCapability } from "@portable-devshell/extension/asset";
import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";

import {
    ExtensionCapabilityAssembler,
    type ExtensionCapabilityAssemblerOptions,
    type ExtensionProcessRuntime,
    type ExtensionWorkerRuntime,
} from "../capability/Assembly.js";
import { ExtensionGeneration } from "../registration/Generation.js";
import { ExtensionPointRegistry } from "../registration/PointRegistry.js";
import { ExtensionRegistrationBuilder } from "../registration/Registration.js";
import {
    sharedExtensionHostModuleResolver,
    type ExtensionHostModuleResolver,
} from "./ModuleResolver.js";
import { readExtensionManifest } from "./Manifest.js";
import {
    assertPlainDirectory,
    assertPlainFile,
    isDirectoryNotEmpty,
    isMissing,
    resolveContainedPath,
} from "./Paths.js";
import { ExtensionPathLayout } from "../state/Layout.js";
import type { ToolCallHistoryCapability } from "@portable-devshell/extension/toolcall";
import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions,
} from "../sandbox/bridge/Host.js";
import type { ExtensionSandboxReadyDescriptor } from "../sandbox/bridge/Protocol.js";
import type { ExtensionConfigRuntime } from "../config/Control.js";
import { readExtensionModule } from "../Entry.js";

export type {
    ExtensionProcessRuntime,
    ExtensionWorkerRuntime,
} from "../capability/Assembly.js";

export interface ExtensionLoaderOptions extends ExtensionCapabilityAssemblerOptions {
    importer?: (url: string) => Promise<unknown>;
    hostModuleResolver?: ExtensionHostModuleResolver;
    loggerFactory?: (id: string, generation: string) => ExtensionLogger;
    paths: ExtensionPathLayout;
    points: ExtensionPointRegistry;
    sandboxFactory?: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    sandboxResourceLimits?: ResourceLimits;
}

export class ExtensionLoader {
    readonly #capabilities: ExtensionCapabilityAssembler;
    readonly #importer?: (url: string) => Promise<unknown>;
    readonly #hostModuleResolver: ExtensionHostModuleResolver;
    readonly #loggerFactory: (
        id: string,
        generation: string,
    ) => ExtensionLogger;
    readonly #paths: ExtensionPathLayout;
    readonly points: ExtensionPointRegistry;
    readonly #runtimeRoots = new Map<string, Promise<void>>();
    readonly #sandboxFactory: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    readonly #sandboxResourceLimits?: ResourceLimits;

    constructor(options: ExtensionLoaderOptions) {
        this.#capabilities = new ExtensionCapabilityAssembler(options);
        this.#importer = options.importer;
        this.#hostModuleResolver =
            options.hostModuleResolver ?? sharedExtensionHostModuleResolver();
        this.#loggerFactory =
            options.loggerFactory ??
            ((id, generation) => consoleExtensionLogger(id, generation));
        this.#paths = options.paths;
        this.points = options.points;
        this.#sandboxFactory =
            options.sandboxFactory ??
            ((sandboxOptions) => new ExtensionSandboxHost(sandboxOptions));
        this.#sandboxResourceLimits = options.sandboxResourceLimits;
    }

    async load(id: string, generation: string): Promise<ExtensionGeneration> {
        const manifest = await this.readManifest(id, generation);
        const codeDirectory = this.#paths.generationDirectory(id, generation);
        const dataDirectory = this.#paths.dataDirectory(id);
        const runtimeRoot = this.#paths.runtimeDirectory(id, generation);
        const stateDirectory = this.#paths.stateDirectory(id);
        const entryPath = resolveContainedPath(
            codeDirectory,
            manifest.entry,
            "Extension entry",
        );
        await assertPlainFile(entryPath, `Extension entry for ${id}`);
        await this.#prepareRuntimeRoot(runtimeRoot);
        await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
        await assertPlainDirectory(
            runtimeRoot,
            `Extension runtime generation root for ${id}`,
        );
        const runtimeDirectory = join(runtimeRoot, `run-${randomUUID()}`);
        await Promise.all([
            mkdir(dataDirectory, { mode: 0o700, recursive: true }),
            mkdir(runtimeDirectory, { mode: 0o700 }),
            mkdir(stateDirectory, { mode: 0o700, recursive: true }),
        ]);

        const {
            artifacts,
            assets,
            config,
            contextCapabilities,
            contextObserve,
            instanceEventPublish,
            instanceManage,
            instanceObserve,
            processes,
            toolCallHistory,
            workerDelegate,
            workerExecute,
        } = await this.#capabilities.assemble({
            dataDirectory,
            extensionId: id,
            generation,
            manifest,
            stateDirectory,
        });
        const logger = this.#loggerFactory(id, generation);
        const registrations = new ExtensionRegistrationBuilder(
            manifest,
            codeDirectory,
            this.points,
        );
        const register: ExtensionContext["register"] = (
            point,
            localId,
            binding,
        ) => {
            registrations.register(point, localId, binding);
        };
        const context: ExtensionContext = Object.freeze({
            capabilities: contextCapabilities,
            ...(config?.owned === undefined ? {} : { config: config.owned }),
            generation,
            id,
            logger,
            paths: Object.freeze({
                codeDirectory,
                dataDirectory,
                runtimeDirectory,
                stateDirectory,
            }),
            register,
            version: manifest.version,
        });

        if (this.#importer === undefined) {
            return await this.#loadSandboxed({
                artifacts,
                assets,
                codeDirectory,
                config,
                context,
                contextObserve,
                entryPath,
                generation,
                id,
                instanceEventPublish,
                instanceManage,
                instanceObserve,
                logger,
                manifest,
                processes,
                runtimeRoot,
                runtimeDirectory,
                toolCallHistory,
                workerDelegate,
                workerExecute,
            });
        }

        const hostModules = this.#hostModuleResolver.register(
            codeDirectory,
            manifest.hostDependencies,
        );
        let module: ExtensionModule | undefined;
        try {
            module = readExtensionModule(
                await this.#importer(pathToFileURL(entryPath).href),
                id,
            );
            await module.activate(context);
            const bindings = await registrations.finalize();
            return new ExtensionGeneration({
                dispose: async () =>
                    await disposeGeneration(
                        module!,
                        config,
                        processes,
                        workerDelegate,
                        workerExecute,
                        runtimeRoot,
                        runtimeDirectory,
                        hostModules.release,
                    ),
                generation,
                manifest,
                registrations: bindings,
                contextEnvironmentRetired: async (event) => {
                    await module!.contextEnvironmentRetired?.(event);
                },
                instanceGenerationRetired: async (event) => {
                    await module!.instanceGenerationRetired?.(event);
                },
                retireInstanceHostResources: async (instance) => {
                    await Promise.all([
                        workerDelegate.retireInstance(instance),
                        workerExecute.retireInstance(instance),
                    ]);
                },
            });
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await Promise.resolve(module?.deactivate?.()).catch(
                (cleanupError: unknown) => cleanupFailures.push(cleanupError),
            );
            await processes
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            try {
                config?.close();
            } catch (cleanupError) {
                cleanupFailures.push(cleanupError);
            }
            await workerDelegate
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await workerExecute
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory).catch(
                (cleanupError) => cleanupFailures.push(cleanupError),
            );
            try {
                hostModules.release();
            } catch (cleanupError) {
                cleanupFailures.push(cleanupError);
            }
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${id} activation failed and candidate cleanup was incomplete.`,
            );
        }
    }

    async readManifest(
        id: string,
        generation: string,
    ): Promise<ExtensionManifest> {
        return await readExtensionManifest(this.#paths, id, generation);
    }

    async #prepareRuntimeRoot(runtimeRoot: string): Promise<void> {
        let preparation = this.#runtimeRoots.get(runtimeRoot);
        if (preparation === undefined) {
            preparation = (async () => {
                await rm(runtimeRoot, { force: true, recursive: true });
                await mkdir(runtimeRoot, { mode: 0o700, recursive: true });
                await assertPlainDirectory(
                    runtimeRoot,
                    "Extension runtime generation root",
                );
            })();
            this.#runtimeRoots.set(runtimeRoot, preparation);
            void preparation.catch(() =>
                this.#runtimeRoots.delete(runtimeRoot),
            );
        }
        await preparation;
    }

    async #loadSandboxed(input: {
        artifacts: ExtensionArtifactCapability;
        assets: ExtensionAssetCapability;
        codeDirectory: string;
        config?: ExtensionConfigRuntime;
        context: ExtensionContext;
        contextObserve: ExtensionContextObserveCapability;
        entryPath: string;
        generation: string;
        id: string;
        instanceEventPublish: ExtensionInstanceEventPublishCapability;
        instanceManage: ExtensionInstanceManageCapability;
        instanceObserve: ExtensionInstanceObserveCapability;
        logger: ExtensionLogger;
        manifest: ExtensionManifest;
        processes: ExtensionProcessRuntime;
        runtimeRoot: string;
        runtimeDirectory: string;
        toolCallHistory: ToolCallHistoryCapability;
        workerDelegate: ExtensionWorkerRuntime;
        workerExecute: ExtensionWorkerRuntime;
    }): Promise<ExtensionGeneration> {
        let candidate: ExtensionGeneration | undefined;
        const sandbox = this.#sandboxFactory({
            artifacts: input.artifacts,
            assets: input.assets,
            capabilities: input.manifest.capabilities,
            codeDirectory: input.codeDirectory,
            config: input.config?.owned,
            configCore: input.config?.core,
            context: {
                config: input.config?.owned !== undefined,
                generation: input.generation,
                id: input.id,
                paths: input.context.paths,
                version: input.manifest.version,
            },
            contextObserve: input.contextObserve,
            entryUrl: pathToFileURL(input.entryPath).href,
            hostDependencies: input.manifest.hostDependencies,
            instanceEventPublish: input.instanceEventPublish,
            instanceManage: input.instanceManage,
            instanceObserve: input.instanceObserve,
            logger: input.logger,
            onFault: (error) => {
                candidate?.fault(error);
                input.config?.close();
                void input.processes.closeAll().catch(() => undefined);
                void input.workerDelegate.closeAll().catch(() => undefined);
                void input.workerExecute.closeAll().catch(() => undefined);
            },
            processes: input.processes,
            ...(this.#sandboxResourceLimits === undefined
                ? {}
                : {
                      resourceLimits: this.#sandboxResourceLimits,
                  }),
            toolCallHistory: input.toolCallHistory,
            workerDelegate: input.workerDelegate,
            workerExecute: input.workerExecute,
        });
        try {
            const descriptor = await sandbox.start();
            const bindings = await registrationsFromSandbox(
                descriptor,
                input.manifest,
                input.codeDirectory,
                this.points,
                sandbox,
            );
            candidate = new ExtensionGeneration({
                dispose: async () =>
                    await disposeSandboxGeneration(
                        sandbox,
                        input.config,
                        input.processes,
                        input.workerDelegate,
                        input.workerExecute,
                        input.runtimeRoot,
                        input.runtimeDirectory,
                    ),
                generation: input.generation,
                manifest: input.manifest,
                registrations: bindings,
                contextEnvironmentRetired: async (event) => {
                    await sandbox.contextEnvironmentRetired(event);
                },
                instanceGenerationRetired: async (event) => {
                    await sandbox.instanceGenerationRetired(event);
                },
                retireInstanceHostResources: async (instance) => {
                    await Promise.all([
                        input.workerDelegate.retireInstance(instance),
                        input.workerExecute.retireInstance(instance),
                    ]);
                },
            });
            if (sandbox.faultError !== undefined) throw sandbox.faultError;
            return candidate;
        } catch (error) {
            const cleanupFailures: unknown[] = [];
            await sandbox
                .dispose()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await input.processes
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            try {
                input.config?.close();
            } catch (cleanupError) {
                cleanupFailures.push(cleanupError);
            }
            await input.workerDelegate
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await input.workerExecute
                .closeAll()
                .catch((cleanupError) => cleanupFailures.push(cleanupError));
            await cleanupRuntimeDirectory(
                input.runtimeRoot,
                input.runtimeDirectory,
            ).catch((cleanupError) => cleanupFailures.push(cleanupError));
            if (cleanupFailures.length === 0) throw error;
            throw new AggregateError(
                [error, ...cleanupFailures],
                `Extension ${input.id} sandbox activation failed and candidate cleanup was incomplete.`,
            );
        }
    }
}

async function registrationsFromSandbox(
    descriptor: ExtensionSandboxReadyDescriptor,
    manifest: ExtensionManifest,
    codeDirectory: string,
    points: ExtensionPointRegistry,
    sandbox: ExtensionSandboxHost,
): Promise<import("../registration/Registration.js").ExtensionRegistrationSet> {
    const registrations = new ExtensionRegistrationBuilder(
        manifest,
        codeDirectory,
        points,
    );
    for (const registration of descriptor.registrations) {
        const binding = points.createSandboxBinding(
            registration.pointId,
            registration.descriptor,
            Object.freeze({
                codeDirectory,
                extensionId: manifest.id,
                id: registration.id,
            }),
            sandbox,
        );
        registrations.registerById(
            registration.pointId,
            registration.id,
            binding,
        );
    }
    return await registrations.finalize();
}

async function disposeGeneration(
    module: ExtensionModule,
    config: ExtensionConfigRuntime | undefined,
    processes: ExtensionProcessRuntime,
    delegatedWorker: ExtensionWorkerRuntime,
    worker: ExtensionWorkerRuntime,
    runtimeRoot: string,
    runtimeDirectory: string,
    releaseHostModules: () => void,
): Promise<void> {
    const failures: unknown[] = [];
    await Promise.resolve(module.deactivate?.()).catch((error) =>
        failures.push(error),
    );
    try {
        config?.close();
    } catch (error) {
        failures.push(error);
    }
    await processes.closeAll().catch((error) => failures.push(error));
    await delegatedWorker.closeAll().catch((error) => failures.push(error));
    await worker.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory).catch(
        (error) => failures.push(error),
    );
    try {
        releaseHostModules();
    } catch (error) {
        failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(
            failures,
            "Extension generation cleanup failed.",
        );
}

async function disposeSandboxGeneration(
    sandbox: ExtensionSandboxHost,
    config: ExtensionConfigRuntime | undefined,
    processes: ExtensionProcessRuntime,
    delegatedWorker: ExtensionWorkerRuntime,
    worker: ExtensionWorkerRuntime,
    runtimeRoot: string,
    runtimeDirectory: string,
): Promise<void> {
    const failures: unknown[] = [];
    await sandbox.dispose().catch((error) => failures.push(error));
    try {
        config?.close();
    } catch (error) {
        failures.push(error);
    }
    await processes.closeAll().catch((error) => failures.push(error));
    await delegatedWorker.closeAll().catch((error) => failures.push(error));
    await worker.closeAll().catch((error) => failures.push(error));
    await cleanupRuntimeDirectory(runtimeRoot, runtimeDirectory).catch(
        (error) => failures.push(error),
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1)
        throw new AggregateError(
            failures,
            "Extension sandbox generation cleanup failed.",
        );
}

async function cleanupRuntimeDirectory(
    runtimeRoot: string,
    runtimeDirectory: string,
): Promise<void> {
    await rm(runtimeDirectory, { force: true, recursive: true });
    await rmdir(runtimeRoot).catch((error: unknown) => {
        if (isMissing(error) || isDirectoryNotEmpty(error)) return;
        throw error;
    });
}

function consoleExtensionLogger(
    id: string,
    generation: string,
): ExtensionLogger {
    const prefix = `[extension:${id}:${generation}]`;
    const write = (
        method: "debug" | "error" | "info" | "warn",
        message: string,
        details?: ExtensionJsonValue,
    ) => {
        if (details === undefined) console[method](`${prefix} ${message}`);
        else console[method](`${prefix} ${message}`, details);
    };
    return {
        debug: (message, details) => write("debug", message, details),
        error: (message, details) => write("error", message, details),
        info: (message, details) => write("info", message, details),
        warn: (message, details) => write("warn", message, details),
    };
}

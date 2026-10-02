import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, rmdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceLimits } from "node:worker_threads";

import {
    parseExtensionManifest,
    type ExtensionContext,
    type ExtensionConfigDeclaration,
    type ExtensionJsonValue,
    type ExtensionLogger,
    type ExtensionManifest,
    type ExtensionModule,
} from "@portable-devshell/extension";
import type { ExtensionAssetCapability } from "@portable-devshell/extension/asset";
import type { ExtensionProcessCapability } from "@portable-devshell/extension/process";
import type { ExtensionWorkerCapability } from "@portable-devshell/extension/worker";
import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";

import type { InstanceRegistry } from "../../../instance/registry/Registry.js";
import { ExtensionAssetCapabilityControl } from "../capability/Asset.js";
import { ExtensionProcessCapabilityControl } from "../capability/Process.js";
import { ExtensionGeneration } from "../registration/Generation.js";
import { ExtensionPointRegistry } from "../registration/PointRegistry.js";
import { ExtensionRegistrationBuilder } from "../registration/Registration.js";
import {
    sharedExtensionHostModuleResolver,
    type ExtensionHostModuleResolver,
} from "./ModuleResolver.js";
import { ExtensionPathLayout } from "../../state/Layout.js";
import { ExtensionInstanceEventPublishCapabilityControl } from "../capability/Instance.js";
import {
    ExtensionToolCallHistoryCapabilityControl,
    type ExtensionToolCallDecorator,
} from "../capability/ToolCallHistory.js";
import type { ToolCallHistoryCapability } from "@portable-devshell/extension/toolcall";
import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions,
} from "../sandbox/bridge/Host.js";
import type { ExtensionSandboxReadyDescriptor } from "../sandbox/bridge/Protocol.js";
import type { ExtensionConfigRuntime } from "../../config/Control.js";

export interface ExtensionWorkerRuntime extends ExtensionWorkerCapability {
    closeAll(): Promise<void>;
    retireInstance(instance: string): Promise<void>;
}

export interface ExtensionProcessRuntime extends ExtensionProcessCapability {
    closeAll(): Promise<void>;
}

export interface ExtensionLoaderOptions {
    artifactFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionArtifactCapability;
    assetsFactory?: (input: {
        allowed: boolean;
        dataDirectory: string;
        extensionId: string;
        generation: string;
    }) => ExtensionAssetCapability;
    configFactory?: (input: {
        declaration: ExtensionConfigDeclaration;
        extensionId: string;
        generation: string;
        stateDirectory: string;
    }) => ExtensionConfigRuntime;
    contextObserveFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionContextObserveCapability;
    importer?: (url: string) => Promise<unknown>;
    instanceFactory?: (input: {
        manageAllowed: boolean;
        observeAllowed: boolean;
        extensionId: string;
        generation: string;
    }) => {
        manage: ExtensionInstanceManageCapability;
        observe: ExtensionInstanceObserveCapability;
    };
    instances: InstanceRegistry;
    hostModuleResolver?: ExtensionHostModuleResolver;
    loggerFactory?: (id: string, generation: string) => ExtensionLogger;
    paths: ExtensionPathLayout;
    points: ExtensionPointRegistry;
    processFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionProcessRuntime;
    sandboxFactory?: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    sandboxResourceLimits?: ResourceLimits;
    toolCallDecorator?: ExtensionToolCallDecorator;
    workerFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
        recording: "caller" | "host";
    }) => ExtensionWorkerRuntime;
}

export class ExtensionLoader {
    readonly #artifactFactory?: ExtensionLoaderOptions["artifactFactory"];
    readonly #assetsFactory?: ExtensionLoaderOptions["assetsFactory"];
    readonly #configFactory?: ExtensionLoaderOptions["configFactory"];
    readonly #contextObserveFactory?: ExtensionLoaderOptions["contextObserveFactory"];
    readonly #importer?: (url: string) => Promise<unknown>;
    readonly #hostModuleResolver: ExtensionHostModuleResolver;
    readonly #instanceFactory?: ExtensionLoaderOptions["instanceFactory"];
    readonly #instances: InstanceRegistry;
    readonly #loggerFactory: (
        id: string,
        generation: string,
    ) => ExtensionLogger;
    readonly #paths: ExtensionPathLayout;
    readonly points: ExtensionPointRegistry;
    readonly #processFactory?: ExtensionLoaderOptions["processFactory"];
    readonly #runtimeRoots = new Map<string, Promise<void>>();
    readonly #sandboxFactory: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    readonly #sandboxResourceLimits?: ResourceLimits;
    readonly #toolCallDecorator?: ExtensionToolCallDecorator;
    readonly #workerFactory?: ExtensionLoaderOptions["workerFactory"];

    constructor(options: ExtensionLoaderOptions) {
        this.#artifactFactory = options.artifactFactory;
        this.#assetsFactory = options.assetsFactory;
        this.#configFactory = options.configFactory;
        this.#contextObserveFactory = options.contextObserveFactory;
        this.#importer = options.importer;
        this.#hostModuleResolver =
            options.hostModuleResolver ?? sharedExtensionHostModuleResolver();
        this.#instanceFactory = options.instanceFactory;
        this.#instances = options.instances;
        this.#loggerFactory =
            options.loggerFactory ??
            ((id, generation) => consoleExtensionLogger(id, generation));
        this.#paths = options.paths;
        this.points = options.points;
        this.#processFactory = options.processFactory;
        this.#sandboxFactory =
            options.sandboxFactory ??
            ((sandboxOptions) => new ExtensionSandboxHost(sandboxOptions));
        this.#sandboxResourceLimits = options.sandboxResourceLimits;
        this.#toolCallDecorator = options.toolCallDecorator;
        this.#workerFactory = options.workerFactory;
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

        const config =
            manifest.config === undefined
                ? undefined
                : this.#configFactory?.({
                      declaration: manifest.config,
                      extensionId: id,
                      generation,
                      stateDirectory,
                  });
        if (manifest.config !== undefined && config === undefined) {
            throw new Error(
                `Extension ${id} declares Config but the host does not provide Config support.`,
            );
        }
        await config?.validate();

        const assets =
            this.#assetsFactory?.({
                allowed: manifest.capabilities.includes("assets"),
                dataDirectory,
                extensionId: id,
                generation,
            }) ??
            new ExtensionAssetCapabilityControl({
                allowed: manifest.capabilities.includes("assets"),
                dataDirectory,
                extensionId: id,
            });

        const artifacts =
            this.#artifactFactory?.({
                allowed: manifest.capabilities.includes("artifacts"),
                extensionId: id,
                generation,
            }) ?? unavailableArtifacts(id);
        const contextObserve =
            this.#contextObserveFactory?.({
                allowed: manifest.capabilities.includes("context.observe"),
                extensionId: id,
                generation,
            }) ?? unavailableContextObserve(id);
        const instanceCapabilities = this.#instanceFactory?.({
            manageAllowed: manifest.capabilities.includes("instance.manage"),
            observeAllowed: manifest.capabilities.includes("instance.observe"),
            extensionId: id,
            generation,
        }) ?? {
            manage: unavailableInstanceManage(id),
            observe: unavailableInstanceObserve(id),
        };
        const instanceEventPublish: ExtensionInstanceEventPublishCapability =
            new ExtensionInstanceEventPublishCapabilityControl({
                allowed: manifest.capabilities.includes(
                    "instance.events.publish",
                ),
                extensionId: id,
                instances: this.#instances,
            });
        const toolCallHistory: ToolCallHistoryCapability =
            new ExtensionToolCallHistoryCapabilityControl({
                allowed: manifest.capabilities.includes("toolcall.history"),
                extensionId: id,
                instances: this.#instances,
                toolCallDecorator: this.#toolCallDecorator,
            });

        const workerExecute = manifest.capabilities.includes("worker.execute")
            ? (this.#workerFactory?.({
                  allowed: true,
                  extensionId: id,
                  generation,
                  recording: "host",
              }) ?? unavailableWorkerRuntime(id, "worker.execute"))
            : unavailableWorkerRuntime(id, "worker.execute");
        const workerDelegate = manifest.capabilities.includes("worker.delegate")
            ? (this.#workerFactory?.({
                  allowed: true,
                  extensionId: id,
                  generation,
                  recording: "caller",
              }) ?? unavailableWorkerRuntime(id, "worker.delegate"))
            : unavailableWorkerRuntime(id, "worker.delegate");
        const processes =
            this.#processFactory?.({
                allowed: manifest.capabilities.includes("processes"),
                extensionId: id,
                generation,
            }) ??
            new ExtensionProcessCapabilityControl({
                allowed: manifest.capabilities.includes("processes"),
                extensionId: id,
                generation,
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
            capabilities: Object.freeze({
                ...(manifest.capabilities.includes("artifacts")
                    ? { artifacts }
                    : {}),
                ...(manifest.capabilities.includes("assets") ? { assets } : {}),
                ...(manifest.capabilities.includes("context.observe")
                    ? { contextObserve }
                    : {}),
                ...(manifest.capabilities.includes("instance.events.publish")
                    ? { instanceEventPublish }
                    : {}),
                ...(manifest.capabilities.includes("instance.manage")
                    ? { instanceManage: instanceCapabilities.manage }
                    : {}),
                ...(manifest.capabilities.includes("instance.observe")
                    ? { instanceObserve: instanceCapabilities.observe }
                    : {}),
                ...(manifest.capabilities.includes("processes")
                    ? { processes }
                    : {}),
                ...(manifest.capabilities.includes("toolcall.history")
                    ? { toolCallHistory }
                    : {}),
                ...(manifest.capabilities.includes("worker.delegate")
                    ? { workerDelegate }
                    : {}),
                ...(manifest.capabilities.includes("worker.execute")
                    ? { workerExecute }
                    : {}),
            }),
            ...(config === undefined ? {} : { config }),
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
                instanceManage: instanceCapabilities.manage,
                instanceObserve: instanceCapabilities.observe,
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
        const codeDirectory = this.#paths.generationDirectory(id, generation);
        await assertPlainDirectory(
            codeDirectory,
            `Extension generation directory for ${id}`,
        );
        const manifestPath = this.#paths.manifestFile(id, generation);
        await assertPlainFile(manifestPath, `Extension manifest for ${id}`);
        const manifest = parseExtensionManifest(
            JSON.parse(await readFile(manifestPath, "utf8")) as unknown,
        );
        if (manifest.id !== id) {
            throw new Error(
                `Extension generation ${generation} declares id ${manifest.id}, expected ${id}.`,
            );
        }
        return manifest;
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
            config: input.config,
            context: {
                config: input.config !== undefined,
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

function unavailableArtifacts(
    extensionId: string,
): ExtensionArtifactCapability {
    const unavailable = (): never => {
        throw new Error(
            `Extension ${extensionId} requested artifacts but the host did not configure that capability.`,
        );
    };
    return Object.freeze({
        cancelTransfer: async () => unavailable(),
        createShare: async () => unavailable(),
        getTransfer: async () => unavailable(),
        listShares: async () => unavailable(),
        listTransfers: async () => unavailable(),
        revokeShare: async () => unavailable(),
        startTransfer: async () => unavailable(),
        waitForTransfer: async () => unavailable(),
    });
}

function unavailableInstanceObserve(
    extensionId: string,
): ExtensionInstanceObserveCapability {
    const unavailable = (): never => {
        throw new Error(
            `Extension ${extensionId} requested instance.observe but the host did not configure that capability.`,
        );
    };
    return Object.freeze({
        list: async () => unavailable(),
        readLogs: async () => unavailable(),
        refresh: async () => unavailable(),
        snapshot: async () => unavailable(),
        watchEvents: async () => unavailable(),
    });
}

function unavailableInstanceManage(
    extensionId: string,
): ExtensionInstanceManageCapability {
    const unavailable = (): never => {
        throw new Error(
            `Extension ${extensionId} requested instance.manage but the host did not configure that capability.`,
        );
    };
    return Object.freeze({
        create: async () => unavailable(),
        createSchema: async () => unavailable(),
        delete: async () => unavailable(),
        disable: async () => unavailable(),
        enable: async () => unavailable(),
        start: async () => unavailable(),
        stop: async () => unavailable(),
        validateCreate: async () => unavailable(),
    });
}

function unavailableContextObserve(
    extensionId: string,
): ExtensionContextObserveCapability {
    const unavailable = (): never => {
        throw new Error(
            `Extension ${extensionId} requested context.observe but the host did not configure that capability.`,
        );
    };
    return Object.freeze({
        list: async () => unavailable(),
    });
}

function unavailableWorkerRuntime(
    extensionId: string,
    capability: "worker.delegate" | "worker.execute",
): ExtensionWorkerRuntime {
    const unavailable = (): never => {
        throw new Error(
            `Extension ${extensionId} requested ${capability} but the host did not configure that capability.`,
        );
    };
    return Object.freeze({
        closeAll: async () => {},
        openSession: async () => unavailable(),
        retireInstance: async () => {},
    });
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

function readExtensionModule(value: unknown, id: string): ExtensionModule {
    if (!isRecord(value) || typeof value.activate !== "function") {
        throw new TypeError(
            `Extension ${id} entry must export an activate(context) function.`,
        );
    }
    if (
        value.deactivate !== undefined &&
        typeof value.deactivate !== "function"
    ) {
        throw new TypeError(
            `Extension ${id} deactivate export must be a function.`,
        );
    }
    if (
        value.contextEnvironmentRetired !== undefined &&
        typeof value.contextEnvironmentRetired !== "function"
    ) {
        throw new TypeError(
            "Extension " +
                id +
                " contextEnvironmentRetired export must be a function.",
        );
    }
    if (
        value.instanceGenerationRetired !== undefined &&
        typeof value.instanceGenerationRetired !== "function"
    ) {
        throw new TypeError(
            `Extension ${id} instanceGenerationRetired export must be a function.`,
        );
    }
    return {
        activate: value.activate as ExtensionModule["activate"],
        ...(value.deactivate === undefined
            ? {}
            : {
                  deactivate: value.deactivate as NonNullable<
                      ExtensionModule["deactivate"]
                  >,
              }),
        ...(value.contextEnvironmentRetired === undefined
            ? {}
            : {
                  contextEnvironmentRetired:
                      value.contextEnvironmentRetired as NonNullable<
                          ExtensionModule["contextEnvironmentRetired"]
                      >,
              }),
        ...(value.instanceGenerationRetired === undefined
            ? {}
            : {
                  instanceGenerationRetired:
                      value.instanceGenerationRetired as NonNullable<
                          ExtensionModule["instanceGenerationRetired"]
                      >,
              }),
    };
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

function resolveContainedPath(
    root: string,
    candidate: string,
    label: string,
): string {
    if (isAbsolute(candidate))
        throw new TypeError(
            `${label} must be relative to the Extension generation.`,
        );
    const resolved = resolve(root, candidate);
    const relativePath = relative(root, resolved);
    if (
        relativePath === "" ||
        (!relativePath.startsWith("..") && !isAbsolute(relativePath))
    )
        return resolved;
    throw new TypeError(`${label} must stay inside the Extension generation.`);
}

async function assertPlainDirectory(
    path: string,
    label: string,
): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError(
            `${label} must be a real directory, not a symlink.`,
        );
    }
}

async function assertPlainFile(path: string, label: string): Promise<void> {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
        throw new TypeError(`${label} must be a regular file, not a symlink.`);
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

function isDirectoryNotEmpty(error: unknown): boolean {
    return (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
    );
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

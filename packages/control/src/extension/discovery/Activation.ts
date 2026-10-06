import { pathToFileURL } from "node:url";
import type { ResourceLimits } from "node:worker_threads";

import type {
    ExtensionContext,
    ExtensionLogger,
    ExtensionManifest,
    ExtensionModule,
} from "@portable-devshell/extension";

import type { ExtensionCapabilitySet } from "../api/cap/Assembly.js";
import { readExtensionModule } from "../Entry.js";
import { ExtensionGeneration } from "../registration/Generation.js";
import type { ExtensionPointRegistry } from "../registration/PointRegistry.js";
import {
    ExtensionRegistrationBuilder,
    type ExtensionRegistrationSet,
} from "../registration/Registration.js";
import {
    ExtensionSandboxHost,
    type ExtensionSandboxHostOptions,
} from "../sandbox/bridge/index.js";
import type { ExtensionSandboxReadyDescriptor } from "../sandbox/bridge/Protocol.js";
import {
    disposeInProcessGeneration,
    disposeSandboxGeneration,
    throwInProcessActivationFailure,
    throwSandboxActivationFailure,
} from "./Cleanup.js";
import {
    sharedExtensionHostModuleResolver,
    type ExtensionHostModuleResolver,
} from "./ModuleResolver.js";

export interface ExtensionGenerationActivatorOptions {
    hostModuleResolver?: ExtensionHostModuleResolver;
    importer?: (url: string) => Promise<unknown>;
    points: ExtensionPointRegistry;
    sandboxFactory?: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    sandboxResourceLimits?: ResourceLimits;
}

export interface ExtensionGenerationActivationInput {
    capabilities: ExtensionCapabilitySet;
    codeDirectory: string;
    context: ExtensionContext;
    entryPath: string;
    generation: string;
    id: string;
    logger: ExtensionLogger;
    manifest: ExtensionManifest;
    registrations: ExtensionRegistrationBuilder;
    runtimeDirectory: string;
    runtimeRoot: string;
}

export class ExtensionGenerationActivator {
    readonly #hostModuleResolver: ExtensionHostModuleResolver;
    readonly #importer?: (url: string) => Promise<unknown>;
    readonly #points: ExtensionPointRegistry;
    readonly #sandboxFactory: (
        options: ExtensionSandboxHostOptions,
    ) => ExtensionSandboxHost;
    readonly #sandboxResourceLimits?: ResourceLimits;

    constructor(options: ExtensionGenerationActivatorOptions) {
        this.#hostModuleResolver =
            options.hostModuleResolver ?? sharedExtensionHostModuleResolver();
        this.#importer = options.importer;
        this.#points = options.points;
        this.#sandboxFactory =
            options.sandboxFactory ??
            ((sandboxOptions) => new ExtensionSandboxHost(sandboxOptions));
        this.#sandboxResourceLimits = options.sandboxResourceLimits;
    }

    async activate(
        input: ExtensionGenerationActivationInput,
    ): Promise<ExtensionGeneration> {
        return this.#importer === undefined
            ? await this.#activateSandbox(input)
            : await this.#activateInProcess(input);
    }

    async #activateInProcess(
        input: ExtensionGenerationActivationInput,
    ): Promise<ExtensionGeneration> {
        const hostModules = this.#hostModuleResolver.register(
            input.codeDirectory,
            input.manifest.hostDependencies,
        );
        let module: ExtensionModule | undefined;
        try {
            module = readExtensionModule(
                await this.#importer!(pathToFileURL(input.entryPath).href),
                input.id,
            );
            await module.activate(input.context);
            const bindings = await input.registrations.finalize();
            return new ExtensionGeneration({
                dispose: async () =>
                    await disposeInProcessGeneration({
                        config: input.capabilities.config,
                        module: module!,
                        processes: input.capabilities.processes,
                        releaseHostModules: hostModules.release,
                        runtimeDirectory: input.runtimeDirectory,
                        runtimeRoot: input.runtimeRoot,
                        workerDelegate: input.capabilities.workerDelegate,
                        workerExecute: input.capabilities.workerExecute,
                    }),
                generation: input.generation,
                manifest: input.manifest,
                registrations: bindings,
                contextEnvironmentRetired: async (event) => {
                    await module!.contextEnvironmentRetired?.(event);
                },
                instanceGenerationRetired: async (event) => {
                    await module!.instanceGenerationRetired?.(event);
                },
                retireInstanceHostResources: async (instance) => {
                    await Promise.all([
                        input.capabilities.workerDelegate.retireInstance(instance),
                        input.capabilities.workerExecute.retireInstance(instance),
                    ]);
                },
            });
        } catch (error) {
            return await throwInProcessActivationFailure(error, {
                config: input.capabilities.config,
                extensionId: input.id,
                module,
                processes: input.capabilities.processes,
                releaseHostModules: hostModules.release,
                runtimeDirectory: input.runtimeDirectory,
                runtimeRoot: input.runtimeRoot,
                workerDelegate: input.capabilities.workerDelegate,
                workerExecute: input.capabilities.workerExecute,
            });
        }
    }

    async #activateSandbox(
        input: ExtensionGenerationActivationInput,
    ): Promise<ExtensionGeneration> {
        let candidate: ExtensionGeneration | undefined;
        const sandbox = this.#sandboxFactory({
            artifacts: input.capabilities.artifacts,
            assets: input.capabilities.assets,
            capabilities: input.manifest.capabilities,
            codeDirectory: input.codeDirectory,
            config: input.capabilities.config?.owned,
            configCore: input.capabilities.config?.core,
            context: {
                config: input.capabilities.config?.owned !== undefined,
                generation: input.generation,
                id: input.id,
                paths: input.context.paths,
                version: input.manifest.version,
            },
            contextObserve: input.capabilities.contextObserve,
            entryUrl: pathToFileURL(input.entryPath).href,
            hostDependencies: input.manifest.hostDependencies,
            instanceEventPublish: input.capabilities.instanceEventPublish,
            instanceManage: input.capabilities.instanceManage,
            instanceObserve: input.capabilities.instanceObserve,
            logger: input.logger,
            onFault: (error) => {
                candidate?.fault(error);
                input.capabilities.config?.close();
                void input.capabilities.processes.closeAll().catch(() => undefined);
                void input.capabilities.workerDelegate
                    .closeAll()
                    .catch(() => undefined);
                void input.capabilities.workerExecute
                    .closeAll()
                    .catch(() => undefined);
            },
            processes: input.capabilities.processes,
            ...(this.#sandboxResourceLimits === undefined
                ? {}
                : { resourceLimits: this.#sandboxResourceLimits }),
            toolCallHistory: input.capabilities.toolCallHistory,
            workerDelegate: input.capabilities.workerDelegate,
            workerExecute: input.capabilities.workerExecute,
        });
        try {
            const descriptor = await sandbox.start();
            const bindings = await registrationsFromSandbox(
                descriptor,
                input.manifest,
                input.codeDirectory,
                this.#points,
                sandbox,
            );
            candidate = new ExtensionGeneration({
                dispose: async () =>
                    await disposeSandboxGeneration({
                        config: input.capabilities.config,
                        processes: input.capabilities.processes,
                        runtimeDirectory: input.runtimeDirectory,
                        runtimeRoot: input.runtimeRoot,
                        sandbox,
                        workerDelegate: input.capabilities.workerDelegate,
                        workerExecute: input.capabilities.workerExecute,
                    }),
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
                        input.capabilities.workerDelegate.retireInstance(instance),
                        input.capabilities.workerExecute.retireInstance(instance),
                    ]);
                },
            });
            if (sandbox.faultError !== undefined) throw sandbox.faultError;
            return candidate;
        } catch (error) {
            return await throwSandboxActivationFailure(error, {
                config: input.capabilities.config,
                extensionId: input.id,
                processes: input.capabilities.processes,
                runtimeDirectory: input.runtimeDirectory,
                runtimeRoot: input.runtimeRoot,
                sandbox,
                workerDelegate: input.capabilities.workerDelegate,
                workerExecute: input.capabilities.workerExecute,
            });
        }
    }
}

async function registrationsFromSandbox(
    descriptor: ExtensionSandboxReadyDescriptor,
    manifest: ExtensionManifest,
    codeDirectory: string,
    points: ExtensionPointRegistry,
    sandbox: ExtensionSandboxHost,
): Promise<ExtensionRegistrationSet> {
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

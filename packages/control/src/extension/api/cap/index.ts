import type {
    ExtensionConfigDeclaration,
    ExtensionContext,
    ExtensionManifest,
} from "@portable-devshell/extension";
import type { ExtensionArtifactCapability } from "@portable-devshell/extension/artifact";
import type { ExtensionAssetCapability } from "@portable-devshell/extension/asset";
import type { ExtensionContextObserveCapability } from "@portable-devshell/extension/context";
import type {
    ExtensionInstanceEventPublishCapability,
    ExtensionInstanceManageCapability,
    ExtensionInstanceObserveCapability,
} from "@portable-devshell/extension/instance";
import type { ExtensionProcessCapability } from "@portable-devshell/extension/process";
import type { ToolCallHistoryCapability } from "@portable-devshell/extension/toolcall";
import type { ExtensionWorkerCapability } from "@portable-devshell/extension/worker";
import type { InstanceRegistry } from "../../../instance/Api.js";
import type { InstanceRuntimeTransport, ToolCallQuery, ToolCallRecord } from "@portable-devshell/shared";

import type { ExtensionConfigRuntime } from "./config/index.js";
import { ExtensionAssetCapabilityControl } from "./asset/index.js";
import { ExtensionInstanceEventPublishCapabilityControl } from "./instance/index.js";
import { ExtensionProcessCapabilityControl } from "./process/index.js";
import { projectExtensionCapabilities } from "./Projection.js";
import {
    ExtensionToolCallHistoryCapabilityControl,
    type ExtensionToolCallDecorator,
} from "./toolcall/index.js";

export interface ExtensionWorkerRuntime extends ExtensionWorkerCapability {
    closeAll(): Promise<void>;
    retireInstance(instance: string): Promise<void>;
}

export interface ExtensionProcessRuntime extends ExtensionProcessCapability {
    closeAll(): Promise<void>;
}

export interface ExtensionCapabilityAssemblerOptions {
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
    instanceFactory?: (input: {
        manageAllowed: boolean;
        observeAllowed: boolean;
        extensionId: string;
        generation: string;
    }) => {
        manage: ExtensionInstanceManageCapability;
        observe: ExtensionInstanceObserveCapability;
    };
    instanceRuntime(instance: string): InstanceRuntimeTransport;
    instances: InstanceRegistry;
    readToolCalls(instance: string, query?: ToolCallQuery): Promise<ToolCallRecord[]>;
    toolCallDecorator?: ExtensionToolCallDecorator;
    workerDelegateFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionWorkerRuntime;
    workerExecuteFactory?: (input: {
        allowed: boolean;
        extensionId: string;
        generation: string;
    }) => ExtensionWorkerRuntime;
}

export interface ExtensionCapabilitySet {
    artifacts: ExtensionArtifactCapability;
    assets: ExtensionAssetCapability;
    config?: ExtensionConfigRuntime;
    contextCapabilities: ExtensionContext["capabilities"];
    contextObserve: ExtensionContextObserveCapability;
    instanceEventPublish: ExtensionInstanceEventPublishCapability;
    instanceManage: ExtensionInstanceManageCapability;
    instanceObserve: ExtensionInstanceObserveCapability;
    processes: ExtensionProcessRuntime;
    toolCallHistory: ToolCallHistoryCapability;
    workerDelegate: ExtensionWorkerRuntime;
    workerExecute: ExtensionWorkerRuntime;
}

export class ExtensionCapabilityAssembler {
    readonly #options: ExtensionCapabilityAssemblerOptions;

    constructor(options: ExtensionCapabilityAssemblerOptions) {
        this.#options = options;
    }

    async assemble(input: {
        dataDirectory: string;
        extensionId: string;
        generation: string;
        manifest: ExtensionManifest;
        stateDirectory: string;
    }): Promise<ExtensionCapabilitySet> {
        const { extensionId, generation, manifest } = input;
        const config =
            manifest.config === undefined
                ? undefined
                : this.#options.configFactory?.({
                      declaration: manifest.config,
                      extensionId,
                      generation,
                      stateDirectory: input.stateDirectory,
                  });
        if (manifest.config !== undefined && config === undefined) {
            throw new Error(
                `Extension ${extensionId} declares Config but the host does not provide Config support.`,
            );
        }
        await config?.validate();

        const assets =
            this.#options.assetsFactory?.({
                allowed: manifest.capabilities.includes("assets"),
                dataDirectory: input.dataDirectory,
                extensionId,
                generation,
            }) ??
            new ExtensionAssetCapabilityControl({
                allowed: manifest.capabilities.includes("assets"),
                dataDirectory: input.dataDirectory,
                extensionId,
            });
        const artifacts =
            this.#options.artifactFactory?.({
                allowed: manifest.capabilities.includes("artifacts"),
                extensionId,
                generation,
            }) ?? unavailableArtifacts(extensionId);
        const contextObserve =
            this.#options.contextObserveFactory?.({
                allowed: manifest.capabilities.includes("context.observe"),
                extensionId,
                generation,
            }) ?? unavailableContextObserve(extensionId);
        const instanceCapabilities = this.#options.instanceFactory?.({
            manageAllowed: manifest.capabilities.includes("instance.manage"),
            observeAllowed: manifest.capabilities.includes("instance.observe"),
            extensionId,
            generation,
        }) ?? {
            manage: unavailableInstanceManage(extensionId),
            observe: unavailableInstanceObserve(extensionId),
        };
        const instanceEventPublish: ExtensionInstanceEventPublishCapability =
            new ExtensionInstanceEventPublishCapabilityControl({
                allowed: manifest.capabilities.includes(
                    "instance.events.publish",
                ),
                extensionId,
                runtime: this.#options.instanceRuntime,
            });
        const toolCallHistory: ToolCallHistoryCapability =
            new ExtensionToolCallHistoryCapabilityControl({
                allowed: manifest.capabilities.includes("toolcall.history"),
                extensionId,
                instances: this.#options.instances,
                toolCallDecorator: this.#options.toolCallDecorator,
                readToolCalls: this.#options.readToolCalls,
            });
        const workerExecute = manifest.capabilities.includes("worker.execute")
            ? (this.#options.workerExecuteFactory?.({
                  allowed: true,
                  extensionId,
                  generation,
              }) ?? unavailableWorkerRuntime(extensionId, "worker.execute"))
            : unavailableWorkerRuntime(extensionId, "worker.execute");
        const workerDelegate = manifest.capabilities.includes("worker.delegate")
            ? (this.#options.workerDelegateFactory?.({
                  allowed: true,
                  extensionId,
                  generation,
              }) ?? unavailableWorkerRuntime(extensionId, "worker.delegate"))
            : unavailableWorkerRuntime(extensionId, "worker.delegate");
        const processes = new ExtensionProcessCapabilityControl({
            allowed: manifest.capabilities.includes("processes"),
            extensionId,
            generation,
        });
        const contextCapabilities = projectExtensionCapabilities(
            manifest.capabilities,
            {
                artifacts: () => artifacts,
                assets: () => assets,
                configCore: () => requireCoreConfig(config, extensionId),
                contextObserve: () => contextObserve,
                instanceEventPublish: () => instanceEventPublish,
                instanceManage: () => instanceCapabilities.manage,
                instanceObserve: () => instanceCapabilities.observe,
                processes: () => processes,
                toolCallHistory: () => toolCallHistory,
                workerDelegate: () => workerDelegate,
                workerExecute: () => workerExecute,
            },
        );
        return {
            artifacts,
            assets,
            config,
            contextCapabilities,
            contextObserve,
            instanceEventPublish,
            instanceManage: instanceCapabilities.manage,
            instanceObserve: instanceCapabilities.observe,
            processes,
            toolCallHistory,
            workerDelegate,
            workerExecute,
        };
    }
}

function requireCoreConfig(
    config: ExtensionConfigRuntime | undefined,
    extensionId: string,
) {
    if (config?.core !== undefined) return config.core;
    throw new Error(
        "Extension " +
            extensionId +
            " declares config.core but the host did not create its Core Config capability.",
    );
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

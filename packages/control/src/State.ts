import {
    createEnvironmentTransport,
    createProcessTransport,
    createToolCallRuntime,
    createToolCallTargetTransport,
    type ControlConfig,
    type Endpoint,
    type ToolCallApi,
    type ToolCallRuntime,
} from "@portable-devshell/shared";

import type { ArtifactRuntime } from "./artifact/Api.js";
import { installArtifactTools } from "./artifact/tool/index.js";
import type { ContextRuntime } from "./context/Api.js";
import { installContextTools } from "./context/Public.js";
import { createDebugRuntime } from "./debug/index.js";
import type { DebugRuntime } from "./debug/Api.js";
import type { ExtensionRuntime } from "./extension/Api.js";
import { CliExtensionCommandService } from "./extension/api/point/cli/command/index.js";
import { McpExtensionService } from "./extension/api/point/mcp/index.js";
import { ToolCallExtensionBinding } from "./extension/api/point/toolcall/index.js";
import { ToolCallSecretRewrite } from "./extension/api/interface/secret/index.js";
import type { BuiltinExtensionSource } from "./extension/install/BuiltinSource.js";
import type { InstanceRegistry } from "./instance/Api.js";
import type { InstanceChangeHub } from "./instance/Change.js";
import type { ToolCallRegistry } from "./toolcall/Api.js";

export interface ControlStateOptions {
    artifact: ArtifactRuntime;
    builtinExtensionSources?: readonly BuiltinExtensionSource[];
    config?: () => ControlConfig;
    contexts: ContextRuntime;
    extensions: ExtensionRuntime;
    instanceChanges: InstanceChangeHub;
    instances: InstanceRegistry;
    internalEndpoint: Endpoint;
    toolRegistry: ToolCallRegistry;
}

export class ControlState {
    readonly artifact: ArtifactRuntime;
    readonly contexts: ContextRuntime;
    readonly debug: DebugRuntime;
    readonly extensions: ExtensionRuntime;
    readonly toolCalls: ToolCallApi;
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #toolCallRuntime: ToolCallRuntime;
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #toolCallRegistryUnbind: () => void;
    #closed = false;

    constructor(options: ControlStateOptions) {
        this.artifact = options.artifact;
        this.contexts = options.contexts;
        this.debug = createDebugRuntime();
        this.extensions = options.extensions;
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ?? []),
        ]);

        const toolCalls = createToolCallRuntime({
            resolveTarget: (name) =>
                createToolCallTargetTransport(options.internalEndpoint, name),
        });
        this.#toolCallRegistryUnbind = options.toolRegistry.bind(toolCalls.hooks);
        this.#toolCallRuntime = toolCalls;
        this.toolCalls = toolCalls.api;

        const extensionToolCalls = new ToolCallExtensionBinding(
            this.extensions,
            new ToolCallSecretRewrite(options.config),
        );
        const extensionMcpTools = new McpExtensionService(this.extensions);
        const modelCliCommands = new CliExtensionCommandService(this.extensions, {
            surface: "model",
        });
        const modelCommands = (instance: string): readonly string[] => {
            const allowed =
                options.instances.get(instance)?.config.modelExtensions ?? [];
            return modelCliCommands
                .list()
                .filter((command) => allowed.includes(command.extensionId))
                .map((command) => command.id);
        };

        this.#toolCallHookUnregister = [
            extensionToolCalls.install(options.toolRegistry),
            extensionMcpTools.install(options.toolRegistry),
            installContextTools(this.contexts.api, options.toolRegistry, {
                environment: (name) =>
                    createEnvironmentTransport(options.internalEndpoint, name),
                leaseInstance: (name) => {
                    const descriptor = options.instances.get(name);
                    if (descriptor === undefined) throw new Error(name);
                    return descriptor.lifecycle.acquireLease();
                },
                modelCommands,
                process: (name) =>
                    createProcessTransport(options.internalEndpoint, name),
            }),
            installArtifactTools(
                this.artifact.service,
                options.instances,
                options.instanceChanges,
                options.toolRegistry,
            ),
        ];
    }

    async start(): Promise<void> {
        await this.artifact.start();
        await this.contexts.initialize();
        await this.extensions.start();
        for (const source of this.#builtinExtensionSources) {
            await this.extensions.installBuiltin(source.id, source.path);
        }
    }

    async reconcile(): Promise<void> {
        await this.contexts.reconcile();
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        const failures: unknown[] = [];
        for (const unregister of this.#toolCallHookUnregister.splice(0).reverse()) {
            try {
                unregister();
            } catch (error) {
                failures.push(error);
            }
        }
        try {
            this.#toolCallRegistryUnbind();
        } catch (error) {
            failures.push(error);
        }
        await this.extensions.stop().catch((error) => failures.push(error));
        await this.debug.close().catch((error) => failures.push(error));
        await this.artifact.stop().catch((error) => failures.push(error));
        this.#toolCallRuntime.close();
        this.contexts.close();
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                "Control domains failed to close cleanly.",
            );
        }
        this.#closed = true;
    }
}

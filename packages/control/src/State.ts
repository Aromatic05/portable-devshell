import {
    createEnvironmentTransport,
    createProcessTransport,
    type ControlConfig,
    type Endpoint,
} from "@portable-devshell/shared";

import type { ArtifactRuntime } from "./artifact/Api.js";
import { installArtifactTools } from "./artifact/tool/index.js";
import type { ContextRuntime } from "./context/Api.js";
import { installContextTools } from "./context/Public.js";
import { ModelCommandBroker } from "./extension/api/point/cli/command/Broker.js";
import { modelCommandAvailable } from "./extension/api/point/cli/command/Access.js";
import { createDebugRuntime } from "./debug/index.js";
import type { DebugRuntime } from "./debug/Api.js";
import type { ExtensionRuntime } from "./extension/Api.js";
import { CliExtensionCommandService } from "./extension/api/point/cli/command/index.js";
import { McpExtensionService } from "./extension/api/point/mcp/index.js";
import { resolveExecutionDrivers } from "./extension/api/point/execution/index.js";
import { ToolCallExtensionBinding } from "./extension/api/point/toolcall/index.js";
import { ToolCallSecretRewrite } from "./extension/api/interface/secret/index.js";
import type { BuiltinExtensionSource } from "./extension/install/BuiltinSource.js";
import type { InstanceRegistry } from "./instance/Api.js";
import type { InstanceChangeHub } from "./instance/Change.js";
import type { ToolCallRegistry } from "./toolcall/Api.js";
import { installInstanceToolDefinitions } from "./toolcall/index.js";

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
    readonly #builtinExtensionSources: readonly BuiltinExtensionSource[];
    readonly #toolCallHookUnregister: Array<() => void>;
    readonly #modelCommands: ModelCommandBroker;
    #closed = false;

    constructor(options: ControlStateOptions) {
        this.artifact = options.artifact;
        this.contexts = options.contexts;
        this.debug = createDebugRuntime();
        this.extensions = options.extensions;
        this.#builtinExtensionSources = Object.freeze([
            ...(options.builtinExtensionSources ?? []),
        ]);

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
                .filter((command) => modelCommandAvailable(command, allowed))
                .map((command) => command.id);
        };

        this.#modelCommands = new ModelCommandBroker({
            changes: options.instanceChanges,
            commands: modelCliCommands,
            contexts: options.contexts.api,
            endpoint: options.internalEndpoint,
            instances: options.instances,
        });

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
            installInstanceToolDefinitions({
                changes: options.instanceChanges,
                hooks: options.toolRegistry,
                instances: options.instances,
            }),
        ];
        const attachExecution = (instance: ReturnType<InstanceRegistry["get"]>): (() => void) => {
            instance?.setExecutionConfigResolver(async (selection) =>
                await resolveExecutionDrivers(this.extensions, selection));
            return () => undefined;
        };
        for (const instance of options.instances.list()) attachExecution(instance);
        this.#toolCallHookUnregister.push(options.instances.onAdding(attachExecution));
    }

    async initialize(): Promise<void> {
        await this.artifact.start();
        await this.contexts.initialize();
    }

    async start(): Promise<void> {
        try {
            await this.extensions.start();
        } catch (error) {
            console.warn("Extension runtime unavailable; Control will continue:", error);
            return;
        }
        for (const source of this.#builtinExtensionSources) {
            try {
                await this.extensions.installBuiltin(source.id, source.path);
            } catch (error) {
                console.warn(`Builtin Extension ${source.id} unavailable:`, error);
            }
        }
    }

    async reconcile(): Promise<void> {
        await this.contexts.reconcile();
    }

    async close(): Promise<void> {
        if (this.#closed) return;
        const failures: unknown[] = [];
        this.#modelCommands.close();
        for (const unregister of this.#toolCallHookUnregister.splice(0).reverse()) {
            try {
                unregister();
            } catch (error) {
                failures.push(error);
            }
        }
        await this.extensions.stop().catch((error) => failures.push(error));
        await this.debug.close().catch((error) => failures.push(error));
        await this.artifact.stop().catch((error) => failures.push(error));
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

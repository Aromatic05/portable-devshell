import type { ControlConfig, Endpoint } from "@portable-devshell/shared";

import type { ContextApi } from "../context/Api.js";
import type { ExtensionControlPort } from "../extension/Api.js";
import type {
    InstanceCreatePort,
    InstanceEditorPort,
    InstanceRegistry,
} from "../instance/Api.js";
import type { ToolCallRegistry } from "../toolcall/Api.js";
import type { CodeObjectProvider, CodeRuntime } from "./Api.js";
import { ControlNativeCodeObjectProvider } from "./registry/ControlNativeProvider.js";
import { ToolCallCodeObjectProvider } from "./registry/ToolCallProvider.js";
import type { QuickJsEngineLimits } from "./runtime/Engine.js";
import { CodeService } from "./Service.js";

export interface CreateCodeRuntimeOptions {
    readonly config?: () => ControlConfig;
    readonly contexts?: ContextApi;
    readonly endpoint: Endpoint;
    readonly extensionControl?: ExtensionControlPort;
    readonly instanceCreate?: InstanceCreatePort;
    readonly instanceEditor?: InstanceEditorPort;
    readonly instances: InstanceRegistry;
    readonly limits?: Partial<QuickJsEngineLimits>;
    readonly providers?: readonly CodeObjectProvider[];
    readonly toolRegistry: ToolCallRegistry;
}

export function createCodeRuntime(
    options: CreateCodeRuntimeOptions,
): CodeRuntime {
    const providers: CodeObjectProvider[] = [
        new ToolCallCodeObjectProvider({
            endpoint: options.endpoint,
            instances: options.instances,
            toolRegistry: options.toolRegistry,
        }),
        new ControlNativeCodeObjectProvider({
            config: options.config,
            contexts: options.contexts,
            endpoint: options.endpoint,
            extensionControl: options.extensionControl,
            instanceCreate: options.instanceCreate,
            instanceEditor: options.instanceEditor,
            instances: options.instances,
        }),
        ...(options.providers ?? []),
    ];
    return new CodeService({
        contexts: options.contexts,
        endpoint: options.endpoint,
        instances: options.instances,
        ...(options.limits === undefined ? {} : { limits: options.limits }),
        providers,
    });
}

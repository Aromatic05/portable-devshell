import { ToolCallHookRegistry } from "./registration/Registry.js";
import type { ToolCallHooks } from "./registration/Api.js";
import type { ToolCallApi } from "./execution/Api.js";
import { ToolCallPipeline, type ToolCallTargetResolver } from "./execution/Pipeline.js";

export interface ToolCallRuntime {
    readonly api: ToolCallApi;
    readonly hooks: ToolCallHooks;
}

export function createToolCallRuntime(options: {
    resolveTarget: ToolCallTargetResolver;
}): ToolCallRuntime {
    const hooks = new ToolCallHookRegistry();
    return {
        api: new ToolCallPipeline({
            hooks: hooks.provider(),
            resolveExecute: (toolName) => hooks.lookupExecute(toolName),
            resolveTarget: options.resolveTarget,
        }),
        hooks,
    };
}

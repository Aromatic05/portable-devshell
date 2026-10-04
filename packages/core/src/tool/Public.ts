import {
    ToolCallHookRegistry,
    type ToolCallApi,
    type ToolCallHooks,
} from "./Runtime.js";
import {
    ToolCallPipeline,
    type ToolCallTargetResolver,
} from "./Pipeline.js";

export type {
    ToolCallApi,
    ToolCallHooks,
} from "./Runtime.js";
export type { ToolCallHookValue } from "./hook/Review.js";

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

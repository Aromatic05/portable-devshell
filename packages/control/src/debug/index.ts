import type { DebugRuntime, DebugRuntimeOptions } from "./Api.js";
import { DebugPatchService } from "./Service.js";

export function createDebugRuntime(
    options: DebugRuntimeOptions,
): DebugRuntime {
    return new DebugPatchService(options.instances, options.target);
}

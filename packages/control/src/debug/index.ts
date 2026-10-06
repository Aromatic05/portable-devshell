import type { DebugRuntime } from "./Api.js";
import { DebugPatchService } from "./Service.js";

export function createDebugRuntime(): DebugRuntime {
    return new DebugPatchService();
}

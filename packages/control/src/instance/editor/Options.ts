import type { Instance, InstanceRegistry } from "@portable-devshell/core";

import { InstanceChangeHub } from "../Change.js";
import type { ConfigEngine } from "../../config/engine/index.js";
import type { InstanceMcpRuntimePort } from "../Mcp.js";

export interface InstanceEditorCoordinatorOptions {
    cleanupDebtFile?: string;
    detachContextInstance?: (instance: string) => Promise<void>;
    engine: ConfigEngine;
    instanceChanges: InstanceChangeHub;
    instanceRegistry: InstanceRegistry;
    mcp?: InstanceMcpRuntimePort;
    reconcileContextInstanceCleanup?: (
        instance: string,
        descriptor?: Instance,
    ) => Promise<void>;
}

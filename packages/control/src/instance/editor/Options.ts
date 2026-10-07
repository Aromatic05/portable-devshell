import type { InstanceRegistry } from "../Registry.js";
import type { Instance } from "@portable-devshell/core";
import type { ControlConfig } from "@portable-devshell/shared";

import { InstanceChangeHub } from "../Change.js";
import type { ConfigEngine } from "../../config/engine/index.js";
import type { InstanceMcpRuntimePort } from "../Mcp.js";

export interface InstanceEditorCoordinatorOptions {
    cleanupDebtFile?: string;
    createRuntimeInstance(
        config: ControlConfig["instances"][number],
    ): Instance;
    detachContextInstance?: (instance: string) => Promise<void>;
    engine: ConfigEngine;
    instanceChanges: InstanceChangeHub;
    instanceRegistry: InstanceRegistry;
    mcp?: InstanceMcpRuntimePort;
    reconcileContextInstanceCleanup?: (
        instance: string,
        target?: {
            releaseAlerts(workspace: string): Promise<void>;
            releaseReference(reference: string): Promise<void>;
        },
    ) => Promise<void>;
    finalizeRuntimeInstance(descriptor: Instance): Promise<void>;
}

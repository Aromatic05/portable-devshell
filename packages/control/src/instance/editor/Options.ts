import type { Instance, InstanceRegistry } from "@portable-devshell/core";
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
        descriptor?: Instance,
    ) => Promise<void>;
    retireRuntimeInstance(descriptor: Instance): Promise<void>;
    finalizeRuntimeInstance(descriptor: Instance): Promise<void>;
    updateApprovalPolicy(
        instance: string,
        policy: ControlConfig["instances"][number]["approvalPolicy"],
    ): Promise<void>;
}

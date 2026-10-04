import type {
    InstanceDescriptor,
    InstanceFactory,
    InstanceRegistry,
} from "@portable-devshell/core";

import type { ConfigEngine } from "../../config/engine/index.js";
import type { InstanceMcpRuntimePort } from "../Mcp.js";

export interface InstanceEditorCoordinatorOptions {
    cleanupDebtFile?: string;
    detachContextInstance?: (instance: string) => Promise<void>;
    engine: ConfigEngine;
    instanceConfigMapper?: InstanceFactory;
    instanceRegistry: InstanceRegistry;
    mcp?: InstanceMcpRuntimePort;
    reconcileContextInstanceCleanup?: (
        instance: string,
        descriptor?: InstanceDescriptor,
    ) => Promise<void>;
}

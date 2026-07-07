import type { InstanceName } from "../types/InstanceName.js";
import type { WorkspacePath } from "../types/WorkspacePath.js";

export interface InstanceConfig {
    name: InstanceName;
    workspacePath: WorkspacePath;
    env?: Record<string, string>;
}

import type { InstanceName } from "../type/identity/TypeIdentityInstanceName.js";
import type { WorkspacePath } from "../type/identity/TypeIdentityWorkspacePath.js";

export interface InstanceConfig {
    name: InstanceName;
    workspacePath: WorkspacePath;
    env?: Record<string, string>;
}

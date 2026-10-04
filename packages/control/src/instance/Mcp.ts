import type { ControlMcpAuthConfig } from "@portable-devshell/shared";

export interface InstanceMcpRuntimePort {
    registerInstance(
        instance: string,
        auth: ControlMcpAuthConfig,
        workspaceEnabled?: boolean,
    ): void;
    unregisterInstance(instance: string): void;
    retireWorkspaceApp(instance: string): Promise<void>;
}

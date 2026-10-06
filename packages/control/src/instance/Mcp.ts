import type { ControlMcpAuthConfig } from "@portable-devshell/shared";

export interface InstanceMcpRuntimePort {
    registerInstance(instance: string, auth: ControlMcpAuthConfig): void;
    unregisterInstance(instance: string): void;
    retireMcpApp(instance: string): Promise<void>;
}

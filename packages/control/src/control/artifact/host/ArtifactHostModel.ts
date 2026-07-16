import type { ArtifactEventType, EffectiveSecurityMode, JsonValue } from "@portable-devshell/shared";

export interface ArtifactHostAccessContext {
    appendControlEvent(type: ArtifactEventType, data?: JsonValue): Promise<unknown>;
    authorityInstance: string;
    provider: string;
    securityMode: EffectiveSecurityMode;
    workspace?: string;
}

export interface ArtifactHostBridgeOptions {
    homeDirectory: string;
    processCwd?: string;
    storageDir: string;
}

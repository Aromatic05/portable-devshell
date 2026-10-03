import type {
    EffectiveSecurityMode,
} from "@portable-devshell/shared";

export interface ArtifactHostAccessContext {
    authorityInstance: string;
    provider: string;
    securityMode: EffectiveSecurityMode;
}

export interface ArtifactHostBridgeOptions {
    homeDirectory: string;
    storageDir: string;
}

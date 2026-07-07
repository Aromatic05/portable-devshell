import type { ProviderType } from "../types/ProviderType.js";

export interface AuthConfig {
    enabled: boolean;
    provider: ProviderType;
    audience?: string;
    issuer?: string;
}

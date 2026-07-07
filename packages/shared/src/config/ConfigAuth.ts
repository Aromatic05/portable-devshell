import type { ProviderType } from "../type/TypeProviderKind.js";

export interface AuthConfig {
    enabled: boolean;
    provider: ProviderType;
    audience?: string;
    issuer?: string;
}

import type { ControlSecurityMode } from "./ControlConfig.js";

export interface ConfigPresetDefinition {
    image: string;
    preset: string;
}

export interface ConfigNormalizeContext {
    containerPresets: readonly ConfigPresetDefinition[];
    defaultEnabled: boolean;
    defaultMcpEnabled: boolean;
    defaultModelExtensions: readonly string[];
    defaultSecurityMode: ControlSecurityMode;
}

export const defaultConfigNormalizeContext: ConfigNormalizeContext = {
    containerPresets: [
        { image: "archlinux:latest", preset: "arch" },
        { image: "ubuntu:24.04", preset: "ubuntu" },
        { image: "debian:stable", preset: "debian" },
        { image: "alpine:latest", preset: "alpine" },
    ],
    defaultEnabled: true,
    defaultMcpEnabled: true,
    defaultModelExtensions: ["artifact", "instance", "mcp", "secret", "skill"],
    defaultSecurityMode: "disabled",
};

export const MASKED_CONFIG_TOKEN = "********";

export const minimumAuditStorageBytes = 1024 * 1024;

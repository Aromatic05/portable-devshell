import type { JsonValue } from "@portable-devshell/shared";

export function createDefaultInstanceDraft(): Record<string, JsonValue> {
    return {
        enabled: true,
        mcp: { enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: ["file", "bash", "artifact", "tmux", "todo"] } },
        name: "",
        provider: "local",
        security: { mode: "disabled" },
        workspace: ""
    };
}

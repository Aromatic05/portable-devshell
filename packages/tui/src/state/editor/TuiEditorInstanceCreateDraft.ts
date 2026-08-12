import { defaultMcpToolGroups, type JsonValue } from "@portable-devshell/shared";

export function createDefaultInstanceDraft(): Record<string, JsonValue> {
    return {
        approvalPolicy: { mode: "disabled" },
        enabled: true,
        mcp: { auth: "none", enabled: true, tools: { capabilities: ["read", "write", "execute"], groups: [...defaultMcpToolGroups] } },
        name: "",
        provider: "local",
        security: { mode: "disabled" }
    };
}

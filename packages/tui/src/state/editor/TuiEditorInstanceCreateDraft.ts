import { defaultConfigNormalizeContext, type JsonValue } from "@portable-devshell/shared";

export function createDefaultInstanceDraft(): Record<string, JsonValue> {
    return {
        approvalPolicy: { mode: "disabled" },
        enabled: true,
        extensions: { model: [...defaultConfigNormalizeContext.defaultModelExtensions] },
        mcp: { auth: "none", contextMode: "explicit", enabled: true },
        name: "",
        provider: "local",
        security: { mode: "disabled" }
    };
}

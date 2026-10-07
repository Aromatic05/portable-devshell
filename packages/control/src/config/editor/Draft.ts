import {
    MASKED_CONFIG_TOKEN,
    normalizeConfigDraft,
    parseConfigDraft,
    toConfigView,
    type ConfigDraft,
    type JsonValue,
} from "@portable-devshell/shared";
import type { ConfigEngine } from "../engine/index.js";

export class ConfigDraftValidator {
    constructor(private readonly engine: ConfigEngine) {}

    validate(params: JsonValue | undefined): JsonValue {
        const draft = this.engine.readInput(() =>
            parseConfigDraft(stripConfigViewMetadata(params)),
        );
        const config = this.engine.readInput(() =>
            normalizeConfigDraft(this.#resolveMaskedTokens(draft)),
        );
        return toConfigView(
            this.engine.validateConfig(config),
            this.engine.restartControlRequired,
        ) as unknown as JsonValue;
    }

    #resolveMaskedTokens(draft: ConfigDraft): ConfigDraft {
        const current = this.engine.current;
        const webAuth = current.web.auth;
        const web =
            draft.web?.token === MASKED_CONFIG_TOKEN && webAuth.mode === "token"
                ? { ...draft.web, token: webAuth.token }
                : draft.web;
        const mcp =
            draft.mcp?.oauth2?.token === MASKED_CONFIG_TOKEN &&
            current.mcp.oauth2.approval === "token"
                ? {
                      ...draft.mcp,
                      oauth2: {
                          ...draft.mcp.oauth2,
                          token: current.mcp.oauth2.token,
                      },
                  }
                : draft.mcp;
        const instances = draft.instances?.map((instance) => {
            if (instance.mcp?.token !== MASKED_CONFIG_TOKEN) return instance;
            const existing = current.instances.find(
                (candidate) => candidate.name === instance.name,
            );
            if (existing?.mcp.auth.mode !== "token") return instance;
            return {
                ...instance,
                mcp: { ...instance.mcp, token: existing.mcp.auth.token },
            };
        });
        return { ...draft, mcp, web, instances };
    }
}

function stripConfigViewMetadata(
    value: JsonValue | undefined,
): JsonValue | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return value;
    const { restartControlRequired: _restartControlRequired, ...config } =
        value;
    return config;
}

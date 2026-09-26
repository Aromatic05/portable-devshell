import {
    configInputError,
    normalizeConfigInstanceDraft,
    parseConfigGlobalDraft,
    parseConfigInstanceDraft,
    parseMcpAuthDraft,
    type ConfigGlobalDraft,
    type ConfigInstanceDraft,
    type ConfigMcpAuthDraft,
    type ControlInstanceConfig,
} from "@portable-devshell/shared";

export interface ConfigGlobalMigrationState {
    legacyMcpAuth?: ConfigMcpAuthDraft;
    required: boolean;
}

export interface ConfigInstanceMigrationResult {
    config: ControlInstanceConfig;
    required: boolean;
}

/**
 * @compat config-global-v1
 * @removeAt 1.0.0
 */
export function migrateGlobalConfigV1(
    config: Record<string, unknown>,
): ConfigGlobalDraft {
    const mcp = asRecord(config.mcp);
    const legacyAuth =
        mcp.auth === undefined
            ? undefined
            : parseMcpAuthDraft(mcp.auth, ["mcp", "auth"]);
    const { auth: _auth, ...mcpWithoutAuth } = mcp;
    return Object.assign(
        parseConfigGlobalDraft({ ...config, mcp: mcpWithoutAuth }),
        { legacyMcpAuth: legacyAuth, migratedFromVersion: 1 as const },
    );
}

/**
 * @compat config-instance-v2-v3
 * @removeAt 1.0.0
 */
export function migrateInstanceConfigV2OrV3(
    config: Record<string, unknown>,
    version: 2 | 3,
): ConfigInstanceDraft {
    const { workspace: _legacyWorkspace, ...legacy } = config;
    const draft = parseConfigInstanceDraft(stripLegacyMcpTools(legacy));
    return Object.assign(draft, {
        migratedFromVersion: version,
        mcp: {
            ...draft.mcp,
            contextMode: draft.mcp?.contextMode ?? "explicit",
        },
        workspace: { enabled: true },
    });
}

export function inspectGlobalConfigMigration(
    draft: ConfigGlobalDraft,
): ConfigGlobalMigrationState {
    const migration = draft as ConfigGlobalDraftWithMigration;
    return {
        ...(migration.legacyMcpAuth === undefined
            ? {}
            : { legacyMcpAuth: migration.legacyMcpAuth }),
        required: migration.migratedFromVersion !== undefined,
    };
}

export function normalizeMigratedInstanceConfig(
    draft: ConfigInstanceDraft,
    globalMigration: ConfigGlobalMigrationState,
): ConfigInstanceMigrationResult {
    const instanceMigration = draft as ConfigInstanceDraftWithMigration;
    return {
        config: normalizeConfigInstanceDraft({
            ...draft,
            mcp:
                draft.mcp?.enabled === false ||
                globalMigration.legacyMcpAuth === undefined
                    ? draft.mcp
                    : {
                          ...draft.mcp,
                          contextMode: "explicit",
                          ...toLegacyInstanceAuth(
                              globalMigration.legacyMcpAuth,
                          ),
                      },
        }),
        required: instanceMigration.migratedFromVersion !== undefined,
    };
}

type ConfigGlobalDraftWithMigration = ConfigGlobalDraft & {
    legacyMcpAuth?: ConfigMcpAuthDraft;
    migratedFromVersion?: 1;
};

type ConfigInstanceDraftWithMigration = ConfigInstanceDraft & {
    migratedFromVersion?: 2 | 3;
};

function stripLegacyMcpTools(
    config: Record<string, unknown>,
): Record<string, unknown> {
    if (config.mcp === undefined) return config;
    const mcp = asRecord(config.mcp);
    const { tools: _legacyTools, ...mcpWithoutTools } = mcp;
    return { ...config, mcp: mcpWithoutTools };
}

function toLegacyInstanceAuth(auth: ConfigMcpAuthDraft) {
    if (auth.mode === "none") return { auth: "none" as const };
    if (auth.mode === "token")
        return { auth: "token" as const, token: auth.token };
    return { auth: "oauth2" as const, oauth2: auth.oauth2 };
}

function asRecord(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw configInputError(
            "parse",
            [],
            "config.document.object",
            "must be an object",
        );
    }
    return value as Record<string, unknown>;
}

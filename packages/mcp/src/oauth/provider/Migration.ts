import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AdapterPayload } from "oidc-provider";
import { isMcpOAuthStorageMissing } from "../Storage.js";

// Exact adapter model names from the installed oidc-provider. Temporary files,
// backups and unrelated JSON are never migration inputs.
const MODELS = [
    "Client", "Grant", "Session", "Interaction", "AccessToken", "AuthorizationCode",
    "RefreshToken", "ClientCredentials", "DeviceCode", "BackchannelAuthenticationRequest",
    "PushedAuthorizationRequest", "PreAuthorizedCode", "RegistrationAccessToken",
    "InitialAccessToken", "ReplayDetection",
] as const;

interface LegacyRecord {
    id: string;
    payload: AdapterPayload;
    expiresAt: number | null;
    consumed: number | null;
}

export class McpOAuthModelMigrationError extends Error {
    readonly code = "OIDC_MODEL_MIGRATION";
    constructor(readonly model: string, readonly reason: string) {
        super(`OIDC ${model}.json migration: ${reason}; source was preserved.`);
        this.name = "McpOAuthModelMigrationError";
    }
}

/** Import a prior JSON generation exactly once at open. Sources remain intact;
 * rows, model diagnostics and completion markers share one SQLite transaction.
 * A killed importer leaves either the prior generation or the committed import.
 */
export async function migrateOidcJsonState(database: DatabaseSync, directory: string): Promise<void> {
    database.exec("BEGIN IMMEDIATE");
    try {
        const completed = new Set((database.prepare("SELECT model FROM oidc_json_imports").all() as Array<{ model: string }>).map(({ model }) => model));
        const pending = MODELS.filter((model) => !completed.has(model));
        // Databases created by the earlier SQLite adapter are already the active
        // generation. Never resurrect stale JSON beside an active database.
        const hasState = database.prepare("SELECT 1 FROM oidc_records UNION ALL SELECT 1 FROM revoked_grants LIMIT 1").get() !== undefined;
        const hasErrors = database.prepare("SELECT 1 FROM oidc_migration_errors LIMIT 1").get() !== undefined;
        const adoptSqlite = completed.size === 0 && hasState && !hasErrors;
        const mark = database.prepare("INSERT INTO oidc_json_imports (model) VALUES (?)");
        const clear = database.prepare("DELETE FROM oidc_migration_errors WHERE model = ?");
        const diagnostic = database.prepare(`
            INSERT INTO oidc_migration_errors (model, reason) VALUES (?, ?)
            ON CONFLICT(model) DO UPDATE SET reason = excluded.reason
        `);
        const insert = database.prepare(`
            INSERT INTO oidc_records (model, id, payload, expires_at, consumed, grant_id, uid, user_code)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const model of pending) {
            if (!adoptSqlite) {
                const result = await readModel(directory, model);
                if (result instanceof McpOAuthModelMigrationError) {
                    diagnostic.run(model, result.reason);
                    continue;
                }
                for (const record of result) {
                    const grantId = model === "Grant" ? record.id : record.payload.grantId ?? null;
                    // A partially repaired model must respect revocations made
                    // while its original source was unavailable.
                    if (grantId !== null && database.prepare("SELECT id FROM revoked_grants WHERE id = ?").get(grantId)) continue;
                    insert.run(model, record.id, JSON.stringify(record.payload), record.expiresAt, record.consumed,
                        grantId, record.payload.uid ?? null, record.payload.userCode ?? null);
                }
            }
            mark.run(model);
            clear.run(model);
        }
        database.exec("COMMIT");
    } catch (error) {
        database.exec("ROLLBACK");
        throw error;
    }
}

async function readModel(directory: string, model: string): Promise<LegacyRecord[] | McpOAuthModelMigrationError> {
    const path = join(directory, `${model}.json`);
    let found = false;
    try {
        const before = await lstat(path);
        found = true;
        if (!before.isFile() || before.isSymbolicLink()) return new McpOAuthModelMigrationError(model, "expected a regular file, refusing symbolic link or special file");
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        let source: string;
        try {
            const actual = await file.stat();
            if (!actual.isFile() || actual.dev !== before.dev || actual.ino !== before.ino) {
                return new McpOAuthModelMigrationError(model, "source changed while opening");
            }
            source = await file.readFile("utf8");
            const after = await file.stat();
            const current = await lstat(path);
            if (after.size !== actual.size || after.mtimeMs !== actual.mtimeMs || after.ctimeMs !== actual.ctimeMs
                || current.isSymbolicLink() || current.dev !== actual.dev || current.ino !== actual.ino) {
                return new McpOAuthModelMigrationError(model, "source changed while reading");
            }
        } finally { await file.close(); }
        let state: unknown;
        try { state = JSON.parse(source); }
        catch { return new McpOAuthModelMigrationError(model, "invalid JSON"); }
        if (!isObject(state)) return new McpOAuthModelMigrationError(model, "expected a record map");
        const records: LegacyRecord[] = [];
        for (const [id, value] of Object.entries(state)) {
            if (!id || !isObject(value) || !isObject(value.payload)) return new McpOAuthModelMigrationError(model, "invalid record envelope");
            const payload = value.payload;
            if (!optionalInteger(value.expiresAt) || !optionalInteger(value.consumed)
                || !["iat", "exp", "iiat", "consumed"].every((key) => optionalInteger(payload[key]))
                || !["grantId", "uid", "userCode", "clientId", "accountId"].every((key) => payload[key] == null || typeof payload[key] === "string")
                || (payload.scope !== undefined && typeof payload.scope !== "string")
                || !["aud", "resource"].every((key) => payload[key] === undefined || typeof payload[key] === "string"
                    || (Array.isArray(payload[key]) && payload[key].every((item: unknown) => typeof item === "string")))
                || (payload.kind !== undefined && payload.kind !== model)
                || (payload.jti !== undefined && payload.jti !== id)
                || (model === "Client" && payload.client_id !== undefined && payload.client_id !== id)) {
                return new McpOAuthModelMigrationError(model, "invalid record metadata or identity");
            }
            records.push({ id, payload: payload as AdapterPayload, expiresAt: value.expiresAt as number | undefined ?? null,
                consumed: value.consumed as number | undefined ?? payload.consumed as number | undefined ?? null });
        }
        return records;
    } catch (error) {
        if (!found && isMcpOAuthStorageMissing(error)) return [];
        // Do not expose parse excerpts, token identifiers, or secret material.
        return new McpOAuthModelMigrationError(model, "source could not be read safely");
    }
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalInteger(value: unknown): boolean {
    return value === undefined || (typeof value === "number" && Number.isSafeInteger(value));
}
